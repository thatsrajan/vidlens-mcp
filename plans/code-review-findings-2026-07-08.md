# VidLens Code Review — Findings & Work Plan

**Date:** 2026-07-08 (review of main @ caff036, v1.3.1)
**Scope:** Full codebase (~22k source lines, 46 MCP tools), reviewed by five parallel subsystem agents: core YouTube service, MCP server/CLI, persistence layer, visual/STT pipeline, providers/external clients. Every finding below carries file:line evidence verified against the code (two whisper.cpp findings verified empirically against a real `whisper-cli` 1.9.1 binary).

**How to use this document:** Findings are grouped into 9 workstreams, ordered by priority. Each workstream is sized to hand to one agent (or a small team). Check off findings as they land. Every finding has a **Verify** line — the fix isn't done until that check passes. Workstreams 1–4 are independent of each other and can run in parallel; WS7 (refactors) should wait until WS1–2 land to avoid merge pain.

**Overall verdict:** Strong fundamentals (strict TS, parameterized SQL everywhere, execa array args, bounded TTL'd caches, WAL-mode SQLite, 2-OS CI). The systemic disease is **silent degradation** — features that fail quietly and report success. The bugs that matter are confident wrong answers, not crashes.

---

## Workstream 1 — Dead features (features that secretly never work)

### WS1-1 · CRITICAL · whisper.cpp STT provider is non-functional end-to-end
Three independent failures, empirically verified:
- [ ] **(a)** `src/lib/stt/whisper-cpp-provider.ts:55-56` — parses stdout as JSON, but `-oj` writes JSON to `<input>.json`; stdout is bracketed human text (`[00:00:00.000 --> ...] text`). `JSON.parse` always throws. Fix: read the `.json` sidecar file (and delete it after), or drop `-oj` and parse the bracketed format.
- [ ] **(b)** `src/lib/stt/whisper-cpp-provider.ts:76,99-100` — `parseTimestamp` does `value.split(":").map(Number)` but whisper emits SRT-style comma milliseconds (`"00:00:00,000"`) → `Number("00,000")` = NaN → every segment's `tStartSec` falls back to its array index. Fix: `value.replace(",", ".")` before parsing.
- [ ] **(c)** `src/lib/stt/whisper-cpp-provider.ts:46-49` — passes the chunk path directly, but homebrew whisper-cli only accepts flac/mp3/ogg/wav, and the pipeline downloads `bestaudio[ext=m4a]` (`media-downloader.ts:404`); chunker preserves the extension (`chunker.ts:32`). Fix: ffmpeg-convert chunks to 16 kHz WAV before invoking whisper.

Impact: the selector (`selector.ts:25-28`) prefers whisper-cpp first in `auto` mode, so setting `VIDLENS_WHISPER_MODEL_PATH` **actively breaks all transcription**.
**Verify:** integration test that runs the real `whisper-cli` binary on a bundled short m4a fixture and asserts non-empty segments with monotonically increasing, non-index timestamps.

### WS1-2 · HIGH · yt-dlp comment fallback can never return comments
- [ ] `src/lib/ytdlp-client.ts:158-177` — `comments()` passes `--extractor-args youtube:max_comments=N` but never enables extraction (`--write-comments` / `youtube:getcomments`). `max_comments` only caps an extraction that never happens; `payload.comments` is always undefined → returns `[]` as success. `executeFallback` (`youtube-service.ts:3775-3812`) treats the empty array as tier success. Without `YOUTUBE_API_KEY`, `readComments`, `measureAudienceSentiment`, `importComments`, and `analyzeVideoSet`'s sentiment all silently report zero comments with clean `yt_dlp` provenance. Fix: add `--extractor-args "youtube:getcomments;max_comments=N"` (grep confirms `getcomments`/`write-comments` appear nowhere in src/).
**Verify:** run `comments()` against a real video with no API key set; assert non-empty.

### WS1-3 · HIGH · Schema-migration framework is dead code
- [ ] `src/lib/schema-migration.ts:93-118` — `runMigrations`, `KNOWLEDGE_BASE_MIGRATIONS` (incl. the v2 `chunk_type` migration), `MEDIA_STORE_MIGRATIONS`, `VISUAL_INDEX_MIGRATIONS` are referenced **only by tests**. Production DBs never get migrated; `PRAGMA user_version` stays 0; real schema evolution happens ad hoc in constructors (`knowledge-base.ts:192-204`, `media-store.ts:114-121`). Decide: wire it up (call from each store constructor) or delete the framework. If wiring up: migration v2 as written throws on fresh DBs (`ALTER TABLE` on a not-yet-created table) — migrations must run *after* base schema creation or guard on table existence.
**Verify:** open a pre-existing v0 DB fixture, construct the store, assert `user_version` advanced and `chunk_type` exists.

### WS1-4 · MEDIUM · TokenControls contract unreachable from MCP
- [ ] `src/lib/types.ts:30-34`, `src/lib/token-controls.ts`, `src/server/mcp-server.ts` — every tool Input extends `TokenControls` (`compact`/`includeRaw`/`fields`, documented as "applied at the output boundary of every tool"), but no tool `inputSchema` exposes them (all declare `additionalProperties: false`) and `executeTool` never forwards them; only `searchSocialTrends.includeRaw` is wired (mcp-server.ts:1413). Decide: expose in schemas + forward in dispatcher, or delete the dead contract.
**Verify:** call any tool via MCP with `compact: true` and assert the output shape changes (or the params are gone from types).

### WS1-5 · LOW · `includeVideoMeta` is a no-op
- [ ] `src/lib/youtube-service.ts:669-674` — `title: includeVideoMeta ? video.title : video.title` (same for `publishedAt`, `channelTitle`); both ternary branches identical. Fix the ternaries (else branch → undefined) or remove the flag.
**Verify:** `expandPlaylist` with `includeVideoMeta: false` omits the meta fields.

---

## Workstream 2 — Data-loss paths

### WS2-1 · HIGH · Incremental import silently destroys paid Gemini embeddings
- [ ] `src/lib/knowledge-base.ts:653-656, 714-724` — `persistItems` unconditionally calls `rebuildCollectionModel`, which overwrites `embedding_json` for **every** chunk with local LSA vectors and resets the model row to `local`. `resolveEmbeddingSelection` (`embedding-provider.ts:28`) reads *current env*, not the collection's stored algorithm — so adding one video in a session without `GEMINI_API_KEY` silently replaces all Gemini embeddings. The re-reindex at `youtube-service.ts:780-782` only fires when the current input selects gemini. Fix: make the collection's stored algorithm authoritative; refuse (or warn + require explicit flag) to downgrade a gemini collection to local.
- [ ] Related cost bug: `knowledge-base.ts:437-449` — every incremental Gemini import re-embeds the **entire** collection (because rebuild first wiped everything). After the fix above, only embed new/changed chunks.
**Verify:** import video A with gemini env set; unset env; import video B into same collection; assert A's embeddings unchanged and model row still says gemini (or the call fails loudly).

### WS2-2 · HIGH · Rerunning `setup` clobbers a custom `VIDLENS_DATA_DIR`
- [ ] `src/lib/cli-runtime.ts:1135` resolves `dataDir = parsed.dataDir ?? deps.env.VIDLENS_DATA_DIR ?? resolveDefaultDataDir(...)`, ignoring the value already saved in the client config; `buildServerEntry` (cli-runtime.ts:632-635) then unconditionally overwrites it. Re-running `setup` without `--data-dir` resets a custom data dir to platform default, orphaning existing collections/media. Fix: read the existing server entry's `VIDLENS_DATA_DIR` and prefer it (flag > saved config > env > default), like the yt-dlp check at line 147 already does via `setupEnv`.
**Verify:** setup test — pre-existing config with custom data dir, re-run setup without flag, assert data dir preserved.

### WS2-3 · MEDIUM · Model metadata written outside the chunk-update transaction
- [ ] `src/lib/knowledge-base.ts:702-724`, `src/lib/comment-knowledge-base.ts:613-639` — chunk embeddings COMMIT, then `INSERT OR REPLACE INTO collection_models` runs separately. Crash between the two → embeddings inconsistent with stored `idf`/`sigma` → silently wrong search rankings. (`reindexCollectionEmbeddings` at knowledge-base.ts:457-477 already does it correctly in one transaction — mirror that.)
**Verify:** code inspection + a transaction-scope unit test.

### WS2-4 · LOW · Non-atomic deletes
- [ ] `src/lib/knowledge-base.ts:262-265` (`deleteVideo` = two DELETEs, no transaction standalone), `:392-415` (`removeCollection` counts then deletes non-transactionally), `src/lib/media-store.ts:288-314` (`unlinkSync` files *before* DB DELETE — mid-loop exception leaves dangling manifest rows). Wrap in transactions; delete DB rows before/atomically-with files.
**Verify:** unit tests with injected failure mid-delete.

---

## Workstream 3 — MCP dispatch validation (one fix kills a class)

**Systemic issue:** tool `inputSchema`s are advisory — the hand-rolled dispatcher enforces types but not enums or bounds. Recommended: one shared schema-driven validator at the dispatch boundary (validate `args` against the registered `inputSchema` before dispatch), which resolves WS3-1/2/3 together.

### WS3-1 · MEDIUM · Enum params unchecked; `downloadAsset.format` provably crashes
- [ ] `src/server/mcp-server.ts:1476` — `format: readString(args, "format") as ...` accepts any string; `formatToKind`/`ytdlpFormatArg` (`media-downloader.ts:385-410`) are exhaustive switches with no default → `"-f", undefined` in spawn args → TypeError surfaced as opaque `INTERNAL_ERROR`. Same pattern: `listMediaAssets.kind` (1485), `searchSocialTrends.freshness`/`sort` (1410-1411), `platforms` arrays (1397, 1408, 1422, 1433), `analyzeVideoSet`/`analyzePlaylist.analyses` (1153, 1176 — invalid entries silently no-op).
**Verify:** call `downloadAsset` with `format: "bogus"` → structured `INVALID_INPUT`, no crash.

### WS3-2 · MEDIUM · `maxSizeMb` bounds (1–5000) never enforced
- [ ] `src/server/mcp-server.ts:1477,1445` passes raw `optionalNumber`; `media-downloader.ts:52` uses it unclamped → `maxSizeMb: 99999999` or negatives pass through to `--max-filesize`. `optionalNumber` (mcp-server.ts:1608) also admits `Infinity` (only NaN checked). Fix: clamp at dispatch or in MediaDownloader; reject non-finite.
**Verify:** unit test with out-of-range values.

### WS3-3 · LOW · Dispatcher validation errors misreported as `INTERNAL_ERROR`
- [ ] `src/server/mcp-server.ts:1590-1666` — `readString`/`optionalNumber` throw plain `Error`s; `normalizeError` maps anything without `.detail` to `INTERNAL_ERROR`, breaking the `GracefulError` taxonomy the service maintains. Fix: throw `invalidInputDetail`-style errors from arg readers.
**Verify:** missing required arg → `INVALID_INPUT`.

### WS3-4 · LOW · `findSimilarFrames` framePath stripping incomplete
- [ ] `src/server/mcp-server.ts:927-928` strips `framePath` from `results` but `reference.framePath` (types.ts:1562-1565) survives, contradicting the stated intent. Also: input `framePath` accepts any absolute path on disk with no containment to the media store — decide whether to restrict.
**Verify:** output contains no `framePath` keys anywhere (deep scan in test).

---

## Workstream 4 — Small, high-leverage robustness fixes

### WS4-1 · MEDIUM · No timeouts on any raw `fetch`
- [ ] `src/lib/innertube-client.ts:177, 220, 371-380`; `src/lib/ytdlp-client.ts:339`; `src/lib/youtube-api-client.ts:48`; `src/lib/ytdlp-installer.ts:102`; `src/lib/stt/openai-whisper-provider.ts:55`; gemini STT calls — none pass `AbortSignal.timeout(...)`. A stalled response holds an MCP tool call open ~5 min or indefinitely. (Every execa call *does* have a timeout — the fetch paths are the unguarded half.) Fix: shared `fetchWithTimeout` helper, ~30s default.
**Verify:** grep shows every `fetch(` call site passes a signal.

### WS4-2 · HIGH · Rate limiter over-admits under concurrency
- [ ] `src/lib/rate-limiter.ts:79-88` — after sleeping, `acquire` decrements unconditionally with no re-check loop: N concurrent waiters all pass, driving `tokens` deeply negative (the yt-dlp-hammering scenario the limiter exists to prevent). Also `refill()`'s `if (newTokens >= 1)` gate skips fractional refills, so even single-threaded the post-wait decrement can go negative. Fix: loop (`while tokens < cost: compute wait, sleep, refill`) and accumulate fractional tokens.
**Verify:** concurrency test — 10 simultaneous `acquire()`s against a 2/sec bucket; assert admission spacing (the existing suite never tests concurrent acquire).

### WS4-3 · MEDIUM · Hostname suffix match lacks dot boundary
- [ ] `src/lib/video-source.ts:270-273` — `host.endsWith("youtube.com")` matches `notyoutube.com`; same for twitter/instagram/tiktok — misrouting look-alike domains onto the real platform's cookie/extractor config. Fix: `host === d || host.endsWith("." + d)`.
**Verify:** unit tests with `notyoutube.com`, `fake-tiktok.com` → `generic_url`.

### WS4-4 · MEDIUM · Fire-and-forget background enrichment
- [ ] `src/lib/youtube-service.ts:3141-3165` — `void this.importVideos(...).catch(() => {})` and same for `indexVisualContent`: all failures discarded, `backgroundEnrichment.status: "preparing"` can never become done/failed, repeated `exploreYouTube` calls queue duplicate downloads with no dedup. Hints (4533-4537) tell the model prep is underway even after failure. Fix: track in-flight jobs keyed by video/collection; record terminal status somewhere queryable (e.g., cache-store or app_state); dedup.
**Verify:** two rapid `exploreYouTube` calls → one enrichment job; failed job surfaces `failed` status on next call.

### WS4-5 · MEDIUM · API pagination silently caps below advertised limits
- [ ] `src/lib/youtube-api-client.ts:227` — comments `Math.min(maxResults, 100)`, single request, no `pageToken` loop, while service clamps to 200 (`youtube-service.ts:508`). Same for `getPlaylistVideos` (line 365, cap 50 vs advertised 200). Fix: paginate to the requested count.
**Verify:** dry-run/fixture test requesting 150 comments returns 150 (or truncation is flagged in output).

### WS4-6 · MEDIUM · searchVideoSources double-searches TikTok/Instagram with no dedup
- [ ] `src/lib/youtube-service.ts:1645-1797` — with `scrapeCreatorsApiKey` set, tiktok/instagram results come from ScrapeCreators (1649) *and* the web-fallback loop (1713 iterates all platforms unconditionally); never deduped by `assetKey` before `slice(0, maxResults)` (1797). Fix: skip platforms already served by ScrapeCreators, or dedupe by assetKey.
**Verify:** fixture test asserts unique assetKeys.

### WS4-7 · LOW · Misc correctness
- [ ] `src/lib/youtube-service.ts:2690-2691` — user `timezone` → `Intl.DateTimeFormat` throws RangeError as `INTERNAL_ERROR`; validate → `INVALID_INPUT`.
- [ ] `src/lib/youtube-service.ts:2031` — `cached: result.downloadedBytes === 0` infers cache-hit from byte count; return an explicit flag from MediaDownloader.
- [ ] `src/lib/youtube-service.ts:3379-3393` — `defaultVideoCollectionId` calls `requireVideoId` (YouTube-only) on every item, so `importVideos` with a TikTok/X URL and no explicit `collectionId` throws for supported input; derive collection key from `resolveVideoSource` instead.
- [ ] `src/lib/id-parsing.ts:61-62` — fallback regex accepts any URL whose path ends in an 11-char token as a video ID (e.g. `youtube.com/c/TechLinked1`) → wrong-video lookups instead of `INVALID_INPUT`; only run fallback on non-URL raw strings.
- [ ] `src/lib/video-source.ts:282-286` — `canonicalizeUrl` strips the entire query string for all non-YouTube platforms including `generic_url`, collapsing query-param-identified videos to one assetKey; preserve query for `generic_url`.
- [ ] `src/lib/innertube-client.ts:217` — consent retry puts `Domain=.youtube.com` (a Set-Cookie attribute) inside a Cookie request header; send just the cookie pair.
- [ ] `src/lib/media-downloader.ts:57-61` — dedupe conflates `best_video` and `worst_video` (both kind `"video"`); requesting best after worst returns the low-quality asset silently.
- [ ] `src/lib/media-downloader.ts:431-435` — `findDownloadedFile` mtime fallback can register an unrelated "newest usable file" as the asset; restrict to files matching the expected id/output template.

---

## Workstream 5 — Security hardening

### WS5-1 · MEDIUM · SSRF ×2
- [ ] `src/lib/id-parsing.ts:152` + `src/lib/page-extract-client.ts:37-40` — `parseChannelRef` returns any non-YouTube URL verbatim; `getChannelInfo` will `fetch()` internal/metadata endpoints (`http://169.254.169.254/`) and return extracted content.
- [ ] `src/lib/video-source.ts:274` + `media-downloader.ts:50,90` — `generic_url` hands any http(s) URL to yt-dlp with no private-IP/allowlist check.
Context: local single-user MCP server, but an LLM client can be prompt-injected into making these calls. Fix: shared guard rejecting private/link-local/loopback IPs and non-http(s) schemes for `generic_url` and channel-URL passthrough (possibly opt-out env var).
**Verify:** `inspectChannel` / `downloadAsset` with `http://169.254.169.254/` → `INVALID_INPUT`.

### WS5-2 · MEDIUM · Swift script executed from predictable temp path
- [ ] `src/lib/macos-vision.ts:92-98` — `if (!existsSync(scriptPath)) writeFileSync(...)` then executes; a pre-planted file in shared TMPDIR runs arbitrary code. Fix: always write (own content), to a per-user dir (data dir, not TMPDIR), or verify content hash before executing.
**Verify:** plant a different file at the path; assert it's overwritten before execution.

### WS5-3 · MEDIUM · Unverified binary installers, non-atomic yt-dlp download
- [ ] `src/lib/ytdlp-installer.ts:102-120` — streams directly to destPath, no checksum; on Windows a truncated `yt-dlp.exe` passes the executability check next run. Fix: download to temp name + rename; verify against the release `SHA2-256SUMS`.
- [ ] `src/lib/diagnostics/deno-installer.ts:24-40` — same: no checksum, no size limit on `arrayBuffer()`.
**Verify:** simulated truncated download is not accepted as a managed binary.

### WS5-4 · MEDIUM · Redactor coverage gap on import failures
- [ ] `src/lib/youtube-service.ts:3260, 3304`, `src/lib/knowledge-base.ts:644` — `reason: error.message` flows raw into tool output; yt-dlp errors (`ytdlp-client.ts:90-91`) embed full command lines incl. `--cookies <path>`. `redactError` exists but is applied at only 4 call sites. Fix: route every user-visible error message through `redactError`.
**Verify:** grep — no user-facing `error.message` sink bypasses the redactor.

### WS5-5 · MEDIUM · Non-interactive `setup` auto-installs software (consent defaults to yes)
- [ ] `src/lib/cli-runtime.ts:1793-1794` + gates at 159 and 339-343 — non-TTY prompt returns `""`, and `if (!answer || ... !== "n")` treats empty as yes → yt-dlp download and `execSync("npm install -g ...")` run without real consent in scripts/pipes. Fix: non-TTY → default no (or require `--yes`).
**Verify:** setup piped through non-TTY performs no installs without `--yes`.

### WS5-6 · MEDIUM · `setup --client cursor|vscode|chatgpt` silently does nothing
- [ ] `src/lib/cli-runtime.ts:1643-1668` parses them, help lists them (1419), but `renderSetupReport` has no branches → exit 0, nothing configured, no warning. Fix: implement or error clearly.
**Verify:** `setup --client cursor` either configures Cursor or exits non-zero with a message.

### WS5-7 · LOW · Latent injection / unsafe href
- [ ] `src/lib/visual-report.ts:416` — `execSync(\`open "${filePath}"\`)`; `$(...)` survives quotes. Currently unreachable but one call-site change from RCE. Fix: `spawn("open", [filePath])`.
- [ ] `src/lib/visual-report.ts:70` — non-YouTube/X `sourceUrl` passes into `<a href>` unsanitized; a stored `javascript:` URL (settable via `indexVisualContent.sourceVideoUrl`) executes in the report. Fix: allow only http(s) schemes.
- [ ] `src/lib/web-search/serpapi-provider.ts:18` — API key in query string (SerpAPI mandates it); keep error paths URL-free (currently OK — guard with a test/comment).
- [ ] `src/cli.ts:5` — `error.stack ?? error.message` prints stack traces (with absolute paths) for simple usage errors; print `.message` for `CliUserError`.

---

## Workstream 6 — Silent degradation in the visual/STT pipeline

### WS6-1 · HIGH · Chunker bypasses size limits; chunk size never derived from bitrate
- [ ] `src/lib/stt/chunker.ts:25` — short-but-large files (26MB 4-min) skip chunking entirely and blow OpenAI's 26MB / Gemini's ~20MB (+33% base64, `gemini-stt-provider.ts:49`) caps; `maxBytes` is accepted but never used to size chunks (fixed 300s chunks of WAV ≈ 52MB). Fix: chunk when size > maxBytes regardless of duration; derive chunk duration from measured bytes/sec.
**Verify:** unit test with high-bitrate fixture produces all chunks under cap.

### WS6-2 · MEDIUM · STT: no retry/backoff/timeouts; one failure discards all completed chunks
- [ ] `src/lib/stt/gemini-stt-provider.ts:22-31`, `openai-whisper-provider.ts:21-31,55` — sequential loop, any 429/5xx throws away prior chunks; no AbortSignal. Fix: wrap `transcribeOne` in the existing `retry.ts` helper + timeout; consider salvaging completed chunks.
**Verify:** mock 429-then-success → transcript completes.

### WS6-3 · MEDIUM · Chunk temp files never cleaned up
- [ ] `src/lib/stt/chunker.ts:30-49` — `<audio>.chunks/` dirs leak on success and error. Fix: finally-block cleanup owned by the caller.
**Verify:** after transcription (success and induced failure), no `.chunks/` remains.

### WS6-4 · MEDIUM · Timestamp granularity: 300-second segments
- [ ] `src/lib/stt/gemini-stt-provider.ts:71` — one segment per chunk → timestamps quantized to 5-min boundaries. `openai-whisper-provider.ts:50` requests `response_format: "json"` which never returns segments (needs `verbose_json` + whisper-1) → the segment-mapping code at 71-77 is dead and OpenAI gets the same quantization. Fix: `verbose_json` for whisper-1; prompt Gemini for timestamped segments or accept + document the limitation.
**Verify:** OpenAI path returns sub-chunk timestamps in a fixture test.

### WS6-5 · MEDIUM · One bad frame aborts the whole Vision batch
- [ ] `src/lib/macos-vision.ts:53-56` — `if (item.error) throw` inside the results map fails all frames in `indexVisualContent`. Fix: per-frame error capture, continue batch, report failed frames.
**Verify:** batch with one corrupt image indexes the rest.

### WS6-6 · MEDIUM · Visual indexing hard-requires macOS with no degraded mode
- [ ] `src/lib/visual-search.ts:438-441` — unconditional Apple Vision call; on Linux/Windows the whole visual feature throws even with Gemini fully configured. Fix: `process.platform` gate → skip OCR, keep Gemini descriptions/embeddings; clear capability error only when nothing is available.
**Verify:** forced non-darwin platform test indexes with Gemini-only.

### WS6-7 · MEDIUM · Auto-reindex loop that can never satisfy its own coverage check
- [ ] `src/lib/visual-search.ts:656-672` (`coverage < 0.5`) vs `thumbnail-extractor.ts:80` (frames from t=0, default cap 12×20s = 240s) — any video > ~8 min has permanent coverage < 0.5, so every `searchVisualContent` call with `autoIndexIfNeeded` (default true) re-runs indexing incl. ffprobe + Gemini calls. Fix: spread timestamps across full duration (`duration * i / maxFrames`) and/or make the coverage check consistent with the sampler.
**Verify:** 20-min fixture: second search call performs zero re-index work.

### WS6-8 · MEDIUM · Gemini describer swallows quota/auth errors, metadata still claims Gemini
- [ ] `src/lib/gemini-visual-describer.ts:86-88` — `catch { return { framePath } }`; index result still reports `descriptionProvider: "gemini"` (`visual-search.ts:502,522`). Fix: count failures, surface in result, don't stamp provider on undescribed frames; retry on 429.
**Verify:** mocked 429 → result reports description failures.

### WS6-9 · LOW · Per-frame ffmpeg failures indistinguishable from short videos
- [ ] `src/lib/thumbnail-extractor.ts:220-222` — `catch { return null }` with no diagnostic. Surface a count/warning.

---

## Workstream 7 — Architecture refactors (after WS1–2 land)

### WS7-1 · Split `youtube-service.ts` (4,745 lines)
- [ ] Extract in this order (seams already exist as section comments):
  1. `resolution-core.ts` — `executeFallback`, `withCache`, `resolve*`, provenance helpers (lines ~3522-3917) — everything else composes this.
  2. `fixtures.ts` — ~600 lines of `sample*` dry-run methods (only need dataDir/mediaStore).
  3. `knowledge-import-service.ts` — importPlaylist/importVideos/importComments/prepareKnowledgeBaseItems/checkImportReadiness (~700 lines).
  4. `media-visual-service.ts` — downloadAsset/keyframes/visual index+search (~1976-2440).
  5. `insights-service.ts` — trends/competitors/hooks/upload-windows/shorts-vs-long (~2442-2989).
  6. `explore-service.ts` — exploreYouTube + scoring free functions (~2993-3191, 4364-4735).
**Verify:** all existing tests pass unchanged; no file > ~1500 lines.

### WS7-2 · Unify the two knowledge bases (~600 duplicated lines)
- [ ] `src/lib/comment-knowledge-base.ts:831-1205` duplicates 20 helpers verbatim from `knowledge-base.ts` (`buildTermCounts`, `tokenize`, `stem`, `buildIdfMap`, `buildNormalizedVector`, similarity/LSA math, `slugify`, `safeParse*`, `localProvenance`) plus STOP_WORDS and ~250 lines of mirrored class plumbing. Drift already happened: comment KB silently dropped Gemini support; `lexicalSimilarity` signatures differ. Extract a shared `text-math.ts` (or KB base class); restore comment-KB Gemini parity or document its absence.
- [ ] While there: `comment-knowledge-base.ts:727-728` applies `videoIdFilter` in JS after loading every row — push into SQL like `knowledge-base.ts:797-802`.
**Verify:** grep shows each helper defined exactly once; both KB test suites pass.

### WS7-3 · Consolidate triplicated banner/version/dataDir logic
- [ ] `mcp-server.ts:868` hardcodes `version: "1.3.0"` (package.json = 1.3.1) — read from package.json at build/runtime.
- [ ] Tool-count drift: setup banner "44 tools" (`cli-runtime.ts:128`), `banner.ts:13/26` "45 tools", actual registry 46 — derive count from the registry; setup banner should import `banner.ts`.
- [ ] dataDir + yt-dlp resolution duplicated with divergent behavior: `mcp-server.ts:1011-1028` (auto-download fallback) vs `cli-runtime.ts:952-960` (none — `doctor` reports missing yt-dlp that `serve` self-heals). One shared resolver.
- [ ] `src/lib/toml-writer.ts:35` — header regex misses `[table] # comment` and `[ spaced ]`, producing duplicate tables in Codex config; also discards user comments inside replaced tables.
**Verify:** version/tool-count asserted against package.json/registry in a test.

---

## Workstream 8 — Hygiene & test gaps

- [ ] **Delete Dropbox conflict copies from `src/`**: `youtube-service (ultron (2)'s conflicted copy 2026-03-23).ts`, `cli-runtime (...)`, `types (...)`, `mcp-server (...)`, plus `*.orig` (`types.ts.orig`, `youtube-service.ts.orig`, `src/test/mcp-server.test.ts.orig`) and root-level conflicted `README`/`package`/`package-lock`. They're gitignored/tsconfig-excluded but are divergent near-duplicates one glob away from shipping. Root cause: repo lives in Dropbox — consider moving the working copy out of Dropbox (or at least excluding the repo from sync).
- [ ] **Move `my-video/` to its own repo** — a full Remotion project (98 tracked files, the same skill doc vendored into ~30 agent dirs) inside a published npm package's repo.
- [ ] **`docs/` is gitignored but tracked** — `docs/PRD.md` etc. predate the ignore rule; pick one (untrack or un-ignore).
- [ ] **Test gaps** (zero coverage): `MediaDownloader` (findDownloadedFile, size limits, dedupe), `PageExtractClient`, whisper/STT providers against real binaries (see WS1-1), `BraveSearchProvider`/`SerpApiProvider`, `ensureDeno`/`probeJsRuntime` beyond URL building, ScrapeCreators error paths + Reddit/Threads/Pinterest/X normalization, look-alike-hostname routing (WS4-3), concurrent rate-limiter acquire (WS4-2).
- [ ] **Fallback-tier smoke matrix**: run key tools with each tier forced (no API key / yt-dlp only / InnerTube only) — would have caught WS1-1, WS1-2, WS4-5 and the readiness mismatch below.
- [ ] **WS8-x · HIGH (from core review) · `checkImportReadiness` contradicts the real transcript path**: `youtube-service.ts:938-1001` probes only yt-dlp while `resolveTranscript` (3607-3642) tries InnerTube first — `buildVideoDossier` (1086) omits transcripts that `readTranscript` fetches fine, and `fetchTranscriptForIndexing` (3342-3352) skips InnerTube so imports are strictly weaker than reads. Fix: readiness probes the same tier chain reads use; imports use `resolveTranscript`.

---

## Workstream 9 — Cross-session memory (new feature, see discussion)

Everything already persists on disk under `VIDLENS_DATA_DIR` (SQLite WAL + media files; even the active collection lives in `app_state`). What's missing is **session-start awareness** and safety:

> **Observed failure (2026-07-08):** Codex, with vidlens-mcp connected, bypassed it for a video task — used raw yt-dlp directly, extracted what it needed, persisted nothing. Its own post-mortem: agents should (1) check VidLens first (`recallWorkspace`/`listCollections`), (2) import through VidLens when the goal is durable video memory, (3) treat manual tools as fallback and import results back. It called this "workflow discipline, not VidLens design" — but discipline that isn't in context at decision time doesn't exist. The design has to put it there: that is precisely Layer 1 (tool-description breadcrumbs + `recallWorkspace`) and Layer 2 (workflow skill) below.

- [ ] **`recallWorkspace` tool** (or extend `checkSystemHealth`): one cheap call returning a compact digest — collections (name, videos, chunk counts, embedding algorithm, last updated), comment collections, media asset totals/bytes, active collection, visual-index coverage. Tool description should say "call this first in a new session to discover previously imported material."
- [ ] **Tool-description breadcrumbs**: `importVideos`/`importPlaylist` descriptions should state that imports are persistent and to check `listCollections` before re-importing (agents re-download because nothing tells them the data survives).
- [ ] **Expose collections as MCP resources** (`resources/list`) so clients that surface resources show the library without a tool call.
- [ ] **Fix WS2-2 first** — the setup data-dir clobber is the main threat to persistence.
- [ ] **Document the shared-data-dir pattern**: Claude Desktop, Claude Code, and Codex all pointing at the same `VIDLENS_DATA_DIR` (the default already does this) = one shared library across all agents. Add a README section.
- [ ] **Warn against putting the data dir inside Dropbox/iCloud** — SQLite + file sync = corruption/conflict copies (this repo's own conflict files are the cautionary tale).

### WS9-b · Delivery mechanism: server-side awareness + on-demand skill, NOT persistent instructions

Decision (2026-07-08): three layers, in priority order —
- [ ] **Layer 1 — server-side (the real fix, works in every client with zero setup):** `recallWorkspace` tool + breadcrumbs in tool descriptions (items above). MCP tool descriptions travel with the server and re-enter context in every session of every client (Claude Desktop, Claude Code, Codex, Cursor…) automatically — they *are* the persistent instructions, minus the maintenance.
- [ ] **Layer 2 — ship a `vidlens` agent skill for workflows, not awareness:** multi-tool recipes (research a niche → import → dossier → sentiment; visual-search playbook; when to `readTranscript` vs `importVideos`; tier/fallback expectations when no API key). Skills load on demand — only the one-line description costs context until the user actually does video work. Distribution channel already exists: the npm package ships `plugins/**` + `.agents/plugins/marketplace.json`, so the skill can be versioned and released with the server itself (`/publish` pipeline). Add both Claude (`plugins/vidlens/skills/`) and Codex (`.agents/skills/`) layouts.
- [ ] **Layer 3 — avoid CLAUDE.md/AGENTS.md persistent instructions** for this: they cost context in *every* session including non-video ones, must be duplicated per project/user, drift from the server version, and don't travel when the user switches machines/clients. At most, README documents a one-line suggestion users can add themselves.

---

## Suggested execution order

| Phase | Workstreams | Parallelizable? |
|-------|------------|-----------------|
| 1 | WS1 (dead features), WS2 (data loss) | Yes — independent |
| 2 | WS3 (dispatch validator), WS4 (robustness), WS5 (security) | Yes — independent |
| 3 | WS6 (visual/STT degradation) | Yes |
| 4 | WS7 (refactors) — after 1–2 to avoid merge pain | Sequential within |
| 5 | WS8 (hygiene/tests), WS9 (memory feature) | Yes |

Severity totals: 1 critical, 8 high, ~20 medium, ~20 low.
