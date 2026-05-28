# Multi-Platform Ingestion Completion Plan
# (TikTok, X/Twitter, Instagram, Generic URLs — production-grade)

**Date:** 2026-05-09
**Branch:** `codex/codex-plugin-universal-video`
**Companion to:** `plans/2026-05-09-codex-plugin-universal-video.md` (the universal-video framing doc)

This plan closes the residual gaps so VidLens supports **TikTok, X/Twitter, Instagram, generic-URL videos, and local files** as first-class, production-grade ingest sources — at parity with the existing YouTube path where physically possible, and with honest, capability-based degradation where it isn't.

---

## 1. Goal and definition of done

Ship a `vidlens-mcp@1.3.0` release in which a Claude or Codex user can, with one MCP call:

1. **Resolve** any TikTok / X / Instagram / generic / local input into a `VideoSourceRef` with accurate per-platform capability flags.
2. **Discover** social videos by query — natively where possible (YouTube), or via a configurable web-search fallback (Brave / SerpAPI / DuckDuckGo-lite) that yields canonical platform URLs.
3. **Ingest** any supported URL (with optional cookies / browser-cookie auth) into the local media store, surviving rate limits and yt-dlp extractor breakage.
4. **Index visually** every ingested asset (already source-agnostic — verify regression).
5. **Transcribe** non-YouTube assets via an optional STT provider chain (local `whisper.cpp` → Gemini audio → OpenAI Whisper) so `searchTranscripts` works across platforms with source-correct result URLs.
6. **Diagnose** per-platform readiness, yt-dlp freshness, JS-runtime presence, and cookie/auth state from a single `doctor` invocation.
7. **Test** every adapter contract, web-search provider, STT provider, migration, and MCP schema in CI without live network.

**Non-goals (explicit):**

- Native API integrations against Twitter/X, Instagram Graph, or TikTok Business APIs (cost, ToS, account requirements).
- Scraping protected/private/age-gated content beyond what user-supplied cookies enable.
- Building our own video extractors — we lean on `yt-dlp` and treat freshness as the contract.
- Replacing the YouTube-specific tools (`exploreYouTube`, `findVideos`, `inspectVideo`, etc.). They remain YouTube-flavored; a parallel universal surface adds, never removes.

---

## 2. Current state (one-paragraph summary)

The branch already lands the *resolver* (`src/lib/video-source.ts`), schema migrations on `media-store.ts` (`source_platform`, `source_url`, `source_id`, `canonical_url` columns + indexes), a source-aware `MediaDownloader` (yt-dlp for URLs, copy-in for local files), and three new MCP tools — `inspectVideoSource`, `searchVideoSources`, `importVideoSources` — wired into `youtube-service.ts:1371-1569`. A Codex plugin scaffold exists under `plugins/vidlens/`. **What is still missing for a real production multi-platform release:** provider abstraction, cookie/auth plumbing, web-search URL discovery, non-YouTube transcription, yt-dlp/JS-runtime diagnostics, expanded `setup`/`doctor`, knowledge-base parity, and a live smoke matrix.

---

## 3. Gap inventory (what blocks "real" multi-platform support today)

| # | Gap | Symptom today | Blast radius |
|---|---|---|---|
| G1 | No provider-adapter abstraction | All non-YouTube URLs go through one identical yt-dlp invocation; no per-platform extractor args, retries, or error mapping | Reliability, debuggability |
| G2 | Cookies / auth not plumbed | `ytdlp-client.ts` and `media-downloader.ts` never pass `--cookies` or `--cookies-from-browser`; capability flags advertise `cookies` but it is unreachable | IG, X, TikTok rate limits and gated content |
| G3 | Social search returns "skipped" | `searchVideoSources` cannot discover X/IG/TikTok URLs; user must paste them | Discovery UX |
| G4 | No transcript path for non-YouTube | `capabilities.transcript = false` for X/IG/TikTok; `searchTranscripts` and KB are YouTube-only | Semantic search, sentiment, dossiers |
| G5 | No yt-dlp freshness or JS-runtime probe | When YouTube/TikTok extractors break, users see opaque failures | Whole-app stability |
| G6 | `setup` / `doctor` are YouTube-centric | No per-platform readiness, no cookie state, no Codex CLI/Desktop registration check | Onboarding, support load |
| G7 | KB schema not source-aware end-to-end | `importVideos` flow assumes YouTube IDs; no migration of legacy collections to set `sourcePlatform="youtube"` retroactively | Cross-source semantic search |
| G8 | `findVideos` / `exploreYouTube` are YouTube-only | No universal "explore across sources" entry point | Tool surface coherence |
| G9 | Secrets-hygiene tests missing | No regression test asserting cookie-file contents never leak into MCP outputs / logs | Privacy |
| G10 | Codex plugin `.mcp.json` uses repo-relative path | Won't work after `npm i -g vidlens-mcp`; only valid in a checkout | Distribution |
| G11 | No live smoke matrix for non-YouTube | We have parsing tests but nothing that proves an actual TikTok/IG/X URL ingests | Release confidence |
| G12 | Provider capability strings hard-coded | `VideoSourceCapabilities.notes` are static; can't reflect "cookies present", "yt-dlp stale", "STT configured" | Honest provenance |
| G13 | Cross-platform transcript results would still build YouTube timestamp URLs | `knowledge-base.ts` currently formats every transcript hit as `https://youtu.be/<id>?t=<sec>` | Broken links for X/IG/TikTok/generic/local STT |
| G14 | Local-file STT audio extraction not specified | `MediaDownloader` currently rejects `best_audio` for local files | Local `.mp4` can index visually but cannot transcribe |
| G15 | Long STT progress contract missing | MCP handler currently returns only when the tool completes | Long transcriptions look hung in Claude/Codex |

---

## 4. Architecture deltas

### 4.1 Provider adapter layer (closes G1)

New directory `src/lib/providers/` with one module per platform plus a shared interface:

```
src/lib/providers/
  types.ts                  // VideoProvider interface + capability runtime model
  registry.ts               // resolve(VideoSourceRef) → VideoProvider
  youtube-provider.ts       // wraps existing youtube-service helpers
  x-provider.ts
  instagram-provider.ts
  tiktok-provider.ts
  generic-url-provider.ts
  local-file-provider.ts
```

`VideoProvider` interface (sketch — final shape lives in `types.ts`):

```ts
export interface VideoProvider {
  readonly platform: VideoSourcePlatform;
  capabilities(env: ProviderEnv): VideoSourceCapabilities; // dynamic, reflects auth + freshness
  inspect(ref: VideoSourceRef, ctx: ProviderContext): Promise<ProviderInspectResult>;
  download(ref: VideoSourceRef, opts: ProviderDownloadOptions, ctx: ProviderContext): Promise<ProviderDownloadResult>;
  transcribe?(ref: VideoSourceRef, ctx: ProviderContext): Promise<TranscriptRecord>; // YouTube uses captions, others delegate to STT
  comments?(ref: VideoSourceRef, ctx: ProviderContext): Promise<CommentRecord[]>;
  searchByQuery?(query: string, opts: ProviderSearchOptions, ctx: ProviderContext): Promise<SearchItem[]>;
}
```

`ProviderContext` carries `ytDlpBinary`, `cookieStore`, `webSearch`, `stt`, `mediaStore`, `dataDir`, and `redactor`. Adapters never read `process.env` directly — context is injected.

**`media-downloader.ts` change:** instead of branching on `source.platform === "local_file"`, it asks the registry for the provider and calls `provider.download(...)`. The local-file provider does the copy; others build platform-specific yt-dlp args and call a shared `executeYtdlp(args, ctx)` helper.

**`youtube-service.ts` change:** `inspectVideoSource`, `searchVideoSources`, `importVideoSources` delegate to the registry. The bulk of the existing implementation moves into `youtube-provider.ts` so the YouTube path remains identical.

### 4.2 Cookie / auth plumbing (closes G2)

New module `src/lib/auth/cookie-store.ts`. Reads:

| Env var | Meaning |
|---|---|
| `VIDLENS_YOUTUBE_COOKIES_FILE` | Netscape-format cookies file for youtube.com |
| `VIDLENS_X_COOKIES_FILE` | …for x.com |
| `VIDLENS_INSTAGRAM_COOKIES_FILE` | …for instagram.com |
| `VIDLENS_TIKTOK_COOKIES_FILE` | …for tiktok.com |
| `VIDLENS_COOKIES_FROM_BROWSER` | One of `chrome\|safari\|firefox\|edge\|brave\|opera\|chromium\|vivaldi`; passed through as `--cookies-from-browser <name>` |
| `VIDLENS_COOKIES_PROFILE` | Optional browser profile name appended to `--cookies-from-browser <name>:<profile>` |

Resolution order per platform:
1. Platform-specific cookies file if set and readable.
2. `--cookies-from-browser` if set.
3. None.

`CookieStore.argsFor(platform)` returns the yt-dlp args. Cookie *paths* are loggable; cookie *contents* must never be logged. A `Redactor` utility (see §4.7) wraps every yt-dlp `stderr`/`stdout` capture and strips any value matching `/Set-Cookie:.*$/i`, `/^Cookie:.*$/im`, or path-sensitive patterns.

Each provider also supports per-call extractor args. Indicative starting set (verify against current yt-dlp at implementation time):

- TikTok: `--extractor-args "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com"` if vanilla extraction fails.
- Instagram: `--extractor-args "instagram:include_stories=false"`.
- X: `--extractor-args "twitter:legacy_api=false"`.

### 4.3 Web-search URL discovery (closes G3)

New directory `src/lib/web-search/`:

```
src/lib/web-search/
  types.ts                  // WebSearchProvider interface
  brave-provider.ts         // env: BRAVE_API_KEY
  serpapi-provider.ts       // env: SERPAPI_KEY
  duckduckgo-lite-provider.ts  // no key; HTML fetch of html.duckduckgo.com/html
  selector.ts               // chooses provider based on env, with fallback chain
```

`WebSearchProvider.search(query, { sites: string[], maxResults })` returns `Array<{ url, title, snippet }>`. `searchVideoSources` calls it with site-restricted queries when the requested platform is not natively searchable. Results are then fed back through `resolveVideoSource()` to ensure they parse as canonical platform URLs before being returned.

**Selection (`selector.ts`):**

- Default mode `auto`: precedence is Brave (if `BRAVE_API_KEY` set) → SerpAPI (if `SERPAPI_KEY` set) → DuckDuckGo-lite.
- `VIDLENS_WEB_SEARCH_PROVIDER=brave|serpapi|duckduckgo|none|auto` overrides. `none` disables web-search fallback entirely (`searchVideoSources` returns the current "skipped" guidance for non-YouTube platforms).
- The override is documented in `setup` and `doctor` output so users can see exactly which provider is in play.

Provenance: `searched[].mode` stays `"web_fallback"` for compatibility; `searched[].detail` and optional `searched[].providerId` include the provider id (e.g., `"brave"`, `"duckduckgo_lite"`).

DuckDuckGo-lite is intentionally last in the chain because HTML scraping is fragile; it ships with a clear `limitations: ["DuckDuckGo HTML fallback is best-effort and may break without notice."]` whenever it is used.

**Perplexity API note:** considered and explicitly deferred. Perplexity is an answer engine — calling it for URL discovery means paying for LLM synthesis and re-extracting URLs from prose. Brave Search API and SerpAPI both return structured `{url, title, snippet}` results, which is exactly what `searchVideoSources` needs. If a user later asks for Perplexity, it slots in as a sixth `WebSearchProvider` implementation in 1.4.

### 4.4 STT for non-YouTube (closes G4)

New directory `src/lib/stt/`:

```
src/lib/stt/
  types.ts                   // SttProvider interface mirroring embedding-provider.ts shape
  whisper-cpp-provider.ts    // local: looks for `whisper-cli` or `whisper.cpp` on PATH; configurable model file via VIDLENS_WHISPER_MODEL_PATH
  gemini-stt-provider.ts     // uses GoogleGenAI audio understanding (reuses GEMINI_API_KEY); model via VIDLENS_GEMINI_STT_MODEL (default to current preferred Gemini audio model at impl time)
  openai-whisper-provider.ts // POST /v1/audio/transcriptions via bare fetch; env OPENAI_API_KEY; model via VIDLENS_OPENAI_STT_MODEL (default to OpenAI's newest transcription model on the day the work begins)
  selector.ts                // env-driven selection
  chunker.ts                 // silence-detect via ffmpeg `silencedetect`, fall back to fixed windows
```

`SttProvider.transcribe(audioPath, { languageHint? })` returns `TranscriptRecord` with synthetic segments (timestamps reconstructed from STT word/segment boundaries when available, or from chunk boundaries otherwise).

**No length cap.** STT runs to completion for arbitrarily long inputs. The `chunker.ts` module handles long files transparently:
1. Probe duration with ffprobe.
2. If under provider's per-call limit (e.g., OpenAI Whisper has a ~25MB upload cap; Gemini has a longer-form limit), send whole.
3. Otherwise, run ffmpeg `silencedetect` to find natural break points; fall back to fixed 5-minute windows when no silences are detected.
4. Stitch segments with chunk-relative offsets adjusted to absolute timestamps.
5. Surface chunk count in the final tool response (`chunksProcessed`, `totalChunks`) and emit MCP progress notifications while chunks complete when the client provides a progress token.

**Selection (`selector.ts`):**

- Default mode `auto`: precedence is `whisper-cpp` (if binary on PATH) → `gemini` (if `GEMINI_API_KEY`/`GOOGLE_API_KEY` set) → `openai-whisper` (if `OPENAI_API_KEY` set) → none.
- `VIDLENS_STT_PROVIDER=whisper-cpp|gemini|openai|none|auto` overrides.
- `VIDLENS_STT_LANGUAGE_HINT` provides a default language hint (per-call still wins).

Pipeline integration:

- New service helper `transcribeAsset(ref, options)` ensures an audio asset exists, then calls the selected STT provider.
- URL-backed providers create audio assets through yt-dlp with `format: "best_audio"`.
- The local-file provider extracts audio from copied local video files with ffmpeg (`m4a`/`wav`, provider-dependent), registers the audio asset, and never mutates the original source file.
- `youtube-service.importVideos` accepts `VideoSourceRef`s; for non-YouTube it calls `transcribeAsset` instead of `ytdlp-client.transcript`.
- `searchTranscripts` consumes the same `TranscriptRecord` shape, but the KB schema/output becomes source-aware so timestamp URLs use `canonical_url` (plus `?t=`/`#t=` where appropriate) instead of hard-coded YouTube URLs.

**Two MCP surfaces (per locked decision §11.3):**

- New standalone tool **`transcribeVideoSource(source, { language?, sttProvider?, forceReindex? })`** for re-transcription, language switches, and "I already imported it" flows.
- New convenience flag on **`importVideoSources({ ..., transcribe: true })`** for one-shot import-and-transcribe.
- Both call into the same `transcribeAsset` core. Tool descriptions cross-reference each other so Claude/Codex pick the right one.

Compatibility-preserving capability change: keep the existing boolean `transcript` field and add an optional detail field. This keeps `inspectVideoSource` backward compatible in `1.3.0`.

```ts
transcript: boolean; // still means "a transcript path is available right now"
transcriptMode?: "native" | "stt" | "unsupported";
```

Adapters compute both dynamically from runtime context (e.g., `tiktok` returns `transcript: true, transcriptMode: "stt"` only if an STT provider is configured, otherwise `transcript: false, transcriptMode: "unsupported"`).

Progress contract:

- `SttProvider.transcribe(...)` accepts an optional progress reporter.
- `mcp-server.ts` passes a reporter into `YouTubeService` when the MCP request includes a progress token.
- Clients that support progress receive per-chunk updates; clients that do not support progress still receive final `chunksProcessed`, `totalChunks`, and `durationMs`.
- No background transcription queue ships in `1.3.0`; tool calls remain synchronous and honest about estimated runtime.

### 4.5 yt-dlp freshness + JS-runtime diagnostics (closes G5)

New module `src/lib/diagnostics/yt-dlp-freshness.ts`:

- Parses yt-dlp's date-stamped version (`YYYY.MM.DD`).
- Compares to today: <30 days = `fresh`, 30-90 = `stale`, >90 = `severely_stale`.
- Optionally fetches `https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest` (gated on `--no-live` flag) to compare to the latest published tag.
- Exposes a helper `recommendUpdate(): string` returning a one-liner the doctor can print.

New module `src/lib/diagnostics/js-runtime.ts`:

- Probes Deno first (`deno --version`), then Node (always present).
- Sets `YTDLP_JS_RUNTIME` env var for yt-dlp invocations when a runtime is detected.
- Surfaces `runtime: "deno"|"node"|"none"`, `version`, `source: "managed"|"system"`.

New module `src/lib/diagnostics/deno-installer.ts`:

- Mirrors `ytdlp-installer.ts`. Downloads platform-appropriate Deno archive from `https://github.com/denoland/deno/releases/latest/download/`.
- Stores under `<dataDir>/bin/deno`. macOS arm64/x86_64 first; Linux x86_64/aarch64 next; Windows last.

Update flow:

- New CLI command `vidlens-mcp update-deps` (or extend `setup`) that re-downloads yt-dlp and Deno when stale.
- For system-installed yt-dlp: print `pipx upgrade yt-dlp` / `brew upgrade yt-dlp` rather than mutating it.

### 4.6 `setup` and `doctor` expansions (closes G6)

**Codex Desktop / CLI surface (verified on a 2026-05-09 install of `codex-cli 0.118.0`):**

- Config file: `~/.codex/config.toml` (TOML).
- MCP server registration: `[mcp_servers.<name>]` block with `command` and `args` keys (matches the existing `.codex/config.toml` shape in this repo).
- Plugin enablement: requires both a `[marketplaces.<name>]` block (with `source_type = "local"` and `source = "<path>"`, or `source_type = "git"` and a repo URL) and a `[plugins."<plugin>@<marketplace>"] enabled = true` block.
- App bundle: `/Applications/Codex.app`. App support: `~/Library/Application Support/Codex/`.
- CLI binary: `codex` on PATH.

`vidlens-mcp setup --client codex` will:
1. Detect or create `~/.codex/config.toml`.
2. Merge a `[mcp_servers.vidlens-mcp]` block (preserving unrelated blocks).
3. Optionally register the local plugin marketplace pointing at `plugins/vidlens/` (in dev) or the published npm/git source (in release).
4. Optionally enable the `vidlens@vidlens` plugin.
5. Print-only mode (`--print-only`) emits the merged TOML for review without writing.
6. Guide first-run users through all optional universal-ingestion settings: YouTube/Gemini/OpenAI keys, Brave/SerpAPI search keys, STT provider/language/model settings, web-search provider override, browser cookies, and platform-specific cookie files. These values are written into the same MCP env block for Claude Desktop, Claude Code, and Codex; dry-run output redacts API keys while showing configured fields.

A minimal hand-rolled TOML serializer lives in `src/lib/toml-writer.ts` (new) — only dotted-key tables, no inline tables or arrays-of-tables. Sufficient for our surface; avoids adding a TOML dep.

`renderDoctorReport` (in `src/lib/cli-runtime.ts:473`) gains new sections:

```
Platform readiness:
- youtube       : ready              (yt-dlp fresh, JS runtime: deno managed)
- x             : auth required      (no cookies file; --cookies-from-browser not set)
- instagram     : auth required      (no cookies file)
- tiktok        : ready              (cookies file present at <redacted>)
- generic_url   : ready              (yt-dlp extractors: 1900+)
- local_file    : ready

Codex registration:
- Codex CLI binary on PATH:   yes (/Users/rajan/.local/bin/codex)
- Codex CLI mcp config:       ~/.codex/config.toml (vidlens-mcp registered)
- Codex Desktop plugin path:  detected via marketplace.json

STT readiness:
- whisper.cpp on PATH:        no
- Gemini audio (GEMINI_API_KEY): yes
- OpenAI Whisper (OPENAI_API_KEY): no
- Selected provider:          gemini

Web search:
- BRAVE_API_KEY:    yes
- SERPAPI_KEY:      no
- DuckDuckGo-lite:  always-available (best-effort)
```

`renderSetupReport` adds:

- A Codex CLI branch that writes/merges `~/.codex/config.toml` (TOML, not JSON — needs a tiny TOML serializer or a documented manual snippet).
- Print-only mode (`--print-only`) emits the merged TOML for review.
- A new `--client codex` target.
- Cookie-file prompts (opt-in, paths only, never values).

Per-platform smoke: `vidlens-mcp doctor --platform tiktok --no-live` runs a parsing-only test against a known-public sample URL (using `yt-dlp --simulate`).

### 4.7 Privacy & secrets hygiene (closes G9)

New utility `src/lib/redactor.ts`:

- `redactSecrets(text: string, env: NodeJS.ProcessEnv): string` — replaces any value matching configured cookie/key env-var values, plus regex patterns for `Cookie:` / `Set-Cookie:` headers.
- All provider error messages route through this before being attached to `failures[].message`, `searched[].detail`, and `provenance.sourceNotes`.
- Test (`src/test/redactor.test.ts`) feeds known cookie strings through every output surface and asserts they never appear.

### 4.8 Knowledge-base parity (closes G7)

Schema migration in the existing transcript KB (`src/lib/knowledge-base.ts`, not re-read here but follow the `addColumnIfMissing` pattern from `media-store.ts:124`):

- Add `source_platform`, `canonical_url`, `source_id` columns to the videos/items table.
- One-time backfill: rows with NULL `source_platform` set to `"youtube"` and `canonical_url` derived from `videoId` via `buildVideoUrl(id)`.
- `importVideos` accepts arbitrary inputs, calls `resolveVideoSource()`, and stores the canonical fields.
- `SearchRow` carries `source_platform`, `canonical_url`, and `source_id`; `SearchTranscriptsOutput.results[]` adds optional `sourcePlatform`, `canonicalUrl`, and `sourceId` while keeping existing `videoId`/`timestampUrl` fields.
- `timestampUrl` is built from `canonical_url` for non-YouTube rows. YouTube keeps `https://youtu.be/<id>?t=<sec>` for compatibility; generic/local rows use their canonical URL without fabricating a YouTube link when timestamp anchoring is not supported.
- Optional new tool `searchVideoSourcesAcrossKb` (deferred — list as future work).

### 4.9 Universal find/explore surface (closes G8)

Two thin wrappers, additive only:

- `findSourcedVideos` — same input as `findVideos` but routes through `searchVideoSources`. Backward-compat alias keeps `findVideos` YouTube-only.
- `exploreSourcedVideos` — opt-in extension of `exploreYouTube` that runs the YouTube pipeline AND attempts platform-discovery via web search, merging results. Defaults off; controlled by `includePlatforms: ["x","instagram","tiktok"]`.

Both ship behind feature flags (env `VIDLENS_ENABLE_UNIVERSAL_EXPLORE=1`) for the 1.3.0 release; promoted to default in 1.4.0.

### 4.10 Codex plugin distribution fix (closes G10)

- Update `plugins/vidlens/.mcp.json` to two profiles, selected by env at install time:
  - `dev` → `node ../../dist/cli.js serve` (current path; for in-checkout testing).
  - `release` → `npx -y vidlens-mcp serve` (works after publish).
- A `plugins/vidlens/install.md` (the *only* new doc this plan creates, since users need it) documents the `dev` vs `release` split.
- Marketplace entry (`.agents/plugins/marketplace.json`) verified against the published manifest before each release.

---

## 5. File-by-file delta

| File | Status | Change |
|---|---|---|
| `src/lib/video-source.ts` | edit | Keep `VideoSourceCapabilities.transcript: boolean`; add `transcriptMode?: "native"\|"stt"\|"unsupported"`; `notes` becomes a function of runtime context (move static notes into providers) |
| `src/lib/types.ts` | edit | Add compatibility-preserving `transcriptMode`, source-aware transcript result fields, `TranscribeVideoSourceInput/Output`, `WebSearchProviderId`, `SttProviderId`, freshness types |
| `src/lib/media-downloader.ts` | edit | Delegate to `providers/registry.ts`; pull cookie + extractor args from provider context; support provider-managed local-file audio extraction |
| `src/lib/ytdlp-client.ts` | edit | Add `executeWithArgs(extraArgs)` overload; accept cookie args; surface yt-dlp version through `probe()` |
| `src/lib/ytdlp-installer.ts` | edit | Expose `latestUpstreamVersion()` (gated by `--no-live`) for freshness comparison |
| `src/lib/embedding-provider.ts` | unchanged | (used as the design template for STT/web-search) |
| `src/lib/cli-runtime.ts` | edit | New doctor sections, new setup branches, `--client codex`, `--platform <id>`, `--update-deps` |
| `src/lib/install-diagnostics.ts` | edit | Add Codex CLI/Desktop config inspection (`~/.codex/config.toml`, Codex Desktop app bundle path) |
| `src/lib/youtube-service.ts` | edit | `inspectVideoSource`/`searchVideoSources`/`importVideoSources` delegate to provider registry; `searchVideoSources` calls web-search providers for non-YouTube; `importVideos` accepts non-YouTube |
| `src/lib/visual-search.ts` | unchanged | Already source-agnostic; add regression test only |
| `src/lib/knowledge-base.ts` | edit | Schema migration; accept arbitrary `assetKey`; build source-correct transcript result URLs |
| `src/server/mcp-server.ts` | edit | Register new standalone tool `transcribeVideoSource` (always on; no flag); add `transcribe?: boolean` to `importVideoSources` schema; register `findSourcedVideos`/`exploreSourcedVideos` behind `VIDLENS_ENABLE_UNIVERSAL_EXPLORE` flag; pass MCP progress reporter to long STT calls; update existing tool descriptions to reference STT/auth |
| `plugins/vidlens/.mcp.json` | edit | Dev vs release profiles |
| `plugins/vidlens/install.md` | new | One-page setup guide for plugin install (only new doc) |
| `.codex/config.toml` | edit | Add note that the `node dist/cli.js serve` form is for development; production uses `npx vidlens-mcp serve` |
| **New files** | | |
| `src/lib/providers/types.ts` | new | `VideoProvider` interface + context |
| `src/lib/providers/registry.ts` | new | resolve provider for a `VideoSourceRef` |
| `src/lib/providers/youtube-provider.ts` | new | wraps existing youtube path |
| `src/lib/providers/x-provider.ts` | new | yt-dlp + cookie args + extractor args |
| `src/lib/providers/instagram-provider.ts` | new | same; cookies strongly recommended |
| `src/lib/providers/tiktok-provider.ts` | new | same |
| `src/lib/providers/generic-url-provider.ts` | new | best-effort yt-dlp; clear error mapping for unsupported extractors |
| `src/lib/providers/local-file-provider.ts` | new | the existing local-file branch, extracted |
| `src/lib/auth/cookie-store.ts` | new | env → yt-dlp cookie args |
| `src/lib/web-search/types.ts` | new | `WebSearchProvider` interface |
| `src/lib/web-search/brave-provider.ts` | new | Brave Search API |
| `src/lib/web-search/serpapi-provider.ts` | new | SerpAPI |
| `src/lib/web-search/duckduckgo-lite-provider.ts` | new | HTML scrape, last-resort, no key |
| `src/lib/web-search/selector.ts` | new | env-driven selection chain |
| `src/lib/stt/types.ts` | new | `SttProvider` interface |
| `src/lib/stt/whisper-cpp-provider.ts` | new | local binary; chunking |
| `src/lib/stt/gemini-stt-provider.ts` | new | reuses GEMINI_API_KEY |
| `src/lib/stt/openai-whisper-provider.ts` | new | OPENAI_API_KEY; latest OpenAI transcription model via bare fetch (no SDK) |
| `src/lib/stt/selector.ts` | new | env-driven selection chain (`VIDLENS_STT_PROVIDER`) |
| `src/lib/stt/chunker.ts` | new | ffmpeg `silencedetect` + fixed-window fallback for long-form audio |
| `src/lib/diagnostics/yt-dlp-freshness.ts` | new | freshness + recommendation |
| `src/lib/diagnostics/js-runtime.ts` | new | Deno/Node detection |
| `src/lib/diagnostics/deno-installer.ts` | new | mirrors yt-dlp-installer |
| `src/lib/redactor.ts` | new | secrets-redaction utility |
| `src/lib/toml-writer.ts` | new | minimal hand-rolled TOML serializer for Codex config merge |
| `src/lib/progress.ts` | new | small internal progress reporter interface for STT chunks and future long-running tools |
| **New tests** | | |
| `src/test/providers/contract.test.ts` | new | parameterized contract tests against every provider |
| `src/test/providers/youtube-provider.test.ts` | new | mocks ytdlp-client; asserts YouTube path unchanged |
| `src/test/providers/x-provider.test.ts` | new | asserts cookie + extractor args in invocation |
| `src/test/providers/instagram-provider.test.ts` | new | same |
| `src/test/providers/tiktok-provider.test.ts` | new | same |
| `src/test/providers/generic-url-provider.test.ts` | new | unsupported-extractor error mapping |
| `src/test/providers/local-file-provider.test.ts` | new | round-trip copy + ffprobe stub |
| `src/test/auth/cookie-store.test.ts` | new | env → args matrix |
| `src/test/web-search/selector.test.ts` | new | provider precedence under env permutations |
| `src/test/web-search/brave-provider.test.ts` | new | mocked HTTP |
| `src/test/web-search/duckduckgo-lite-provider.test.ts` | new | HTML fixture |
| `src/test/stt/selector.test.ts` | new | env-driven selection |
| `src/test/stt/gemini-stt-provider.test.ts` | new | mocked SDK |
| `src/test/diagnostics/yt-dlp-freshness.test.ts` | new | date-arithmetic + recommendation |
| `src/test/diagnostics/js-runtime.test.ts` | new | runtime probing |
| `src/test/toml-writer.test.ts` | new | round-trip TOML preservation for unrelated blocks; merge correctness |
| `src/test/stt/openai-whisper-provider.test.ts` | new | mocked HTTP against OpenAI audio endpoint; model env override |
| `src/test/stt/chunker.test.ts` | new | silence-detect path + fixed-window fallback; absolute-timestamp stitching |
| `src/test/transcribe-video-source.test.ts` | new | standalone tool schema + provider selection; flag-on flow on `importVideoSources` |
| `src/test/stt/local-file-audio.test.ts` | new | local mp4 -> registered audio asset path for STT |
| `src/test/stt/progress.test.ts` | new | per-chunk progress reporter is called and final counts are returned |
| `src/test/redactor.test.ts` | new | cookie/key contents never appear in outputs |
| `src/test/knowledge-base-source-aware.test.ts` | new | migration sets `source_platform="youtube"` for legacy rows; new rows store correct platform and non-YouTube searches do not emit `youtu.be` URLs |
| `src/test/cli-doctor-platform.test.ts` | new | doctor `--platform tiktok --no-live` reports parser-only check |
| `src/test/cli-setup-codex.test.ts` | new | setup `--client codex --print-only` emits valid TOML |
| `src/test/mcp-server.test.ts` | edit | Adds new tool names while keeping the legacy assertion intact |
| `src/scripts/smoke.ts` | edit | Adds dry-run cases for x, instagram, tiktok, generic_url, local_file |

---

## 6. Phased delivery (TDD per Superpowers methodology)

Each phase: red test → green implementation → refactor → verify → commit. Phases are independently shippable; later phases consume earlier ones but do not require them to be merged.

### Phase 1 — Provider abstraction skeleton (closes G1, prerequisite for G2/G4)
- **Estimate:** 1.5 days
- Build `providers/types.ts`, `providers/registry.ts`, port the existing YouTube path into `providers/youtube-provider.ts` and the existing local-file path into `providers/local-file-provider.ts`.
- `media-downloader.ts` and the three universal MCP service methods now go through the registry.
- Stub `x`/`instagram`/`tiktok`/`generic_url` providers with the *current* yt-dlp behavior — no new args yet — so nothing regresses.
- **Acceptance:** all existing tests pass unchanged; new contract test passes for the YouTube + local-file providers; `mcp-server.test.ts` legacy tool list assertion still green.

### Phase 2 — Cookies + per-platform extractor args (closes G2)
- **Estimate:** 1 day
- Build `auth/cookie-store.ts` and `redactor.ts`.
- Wire cookie args into every non-YouTube provider's `download` call.
- Capability flags reflect cookie state via dynamic `capabilities(env)` method.
- **Acceptance:** `cookie-store.test.ts` covers env matrix; `redactor.test.ts` proves no leakage; provider tests assert cookie args present in mocked yt-dlp invocations.

### Phase 3 — Web-search URL discovery (closes G3)
- **Estimate:** 1.5 days
- Build `web-search/` providers + selector.
- `searchVideoSources` calls `webSearch.search(query, { sites: platformSites })` for non-YouTube platforms when configured; otherwise falls back to current "skipped" behavior with the new honest detail.
- Results pass through `resolveVideoSource()` to canonicalize.
- **Acceptance:** Brave/SerpAPI mocked tests; DuckDuckGo-lite HTML-fixture test; an integration-style test that runs `searchVideoSources` against fixtures and asserts canonical URLs returned.

### Phase 4 — STT providers + `transcribeAsset` (closes G4)
- **Estimate:** 2 days
- Build `stt/` providers + selector.
- New `transcribeAsset(ref)` service helper; new standalone `transcribeVideoSource` MCP tool.
- Keep `capabilities.transcript` as a boolean and add `transcriptMode: "native"|"stt"|"unsupported"` based on STT availability.
- Add local-file audio extraction via ffmpeg so `transcribeVideoSource("/path/to/video.mp4")` works without relying on yt-dlp.
- Wire progress reporter plumbing so chunked STT can emit per-chunk MCP progress updates when supported.
- KB schema migration (Phase 7) needed to fully use this; a feature-flagged path lets non-YouTube transcripts land in KB once both phases are merged.
- **Acceptance:** Whisper.cpp test with pre-canned WAV fixture; Gemini STT test with mocked SDK; local-file audio extraction test; progress reporter test; `transcribeVideoSource` schema test in `mcp-server.test.ts`.

### Phase 5 — yt-dlp freshness + JS runtime + Deno installer (closes G5)
- **Estimate:** 1 day
- Build `diagnostics/yt-dlp-freshness.ts`, `diagnostics/js-runtime.ts`, `diagnostics/deno-installer.ts`.
- Integrate into `youtube-service.checkSystemHealth` and `cli-runtime.renderDoctorReport`.
- New `vidlens-mcp update-deps` CLI command.
- **Acceptance:** date-arithmetic tests; mocked managed/system runtime detection; doctor report snapshot test.

### Phase 6 — `setup` + `doctor` expansions (closes G6)
- **Estimate:** 1.5 days
- Per-platform readiness rows; cookie/auth state (paths only); Codex CLI/Desktop registration check; per-platform smoke flag; `--client codex` setup.
- **Acceptance:** `cli-doctor-platform.test.ts`, `cli-setup-codex.test.ts`; snapshot tests for new doctor sections.

### Phase 7 — Knowledge-base source-awareness + migration (closes G7)
- **Estimate:** 1 day
- Schema columns + backfill; `importVideos` accepts arbitrary sources; tests for legacy collection load.
- `searchTranscripts` returns source-aware metadata and never fabricates YouTube timestamp URLs for non-YouTube rows.
- Wires Phase 4's STT into KB so social transcripts become semantically searchable.
- **Acceptance:** `knowledge-base-source-aware.test.ts`; existing KB tests unchanged; `service.dryrun.test.ts` updated for non-YouTube import.

### Phase 8 — Universal explore/find surface (closes G8)
- **Estimate:** 1 day; feature-flagged
- Add `findSourcedVideos`, `exploreSourcedVideos` behind `VIDLENS_ENABLE_UNIVERSAL_EXPLORE=1`.
- **Acceptance:** schema tests; flag-on/flag-off conditional test.

### Phase 9 — Codex plugin distribution fix (closes G10) and live smoke (G11)
- **Estimate:** 1 day
- `plugins/vidlens/.mcp.json` dev vs release; `install.md`; smoke matrix.
- Manual live matrix run before tagging release.
- **Acceptance:** smoke script exits 0 in `--dry-run` mode for all 5 non-YouTube cases; documented manual live run results.

### Phase 10 — Release & docs (final)
- **Estimate:** 0.5 day
- Bump `package.json`, `server.json`, `server.json.packages[].version`, `plugins/vidlens/.codex-plugin/plugin.json`, and the MCP server metadata version in `src/server/mcp-server.ts` to `1.3.0`.
- Update `CHANGELOG.md` (additive entries only).
- Update `README.md` sections: env vars, cookies setup, STT setup, Codex CLI install, doctor walkthrough.
- Run `npm run release:verify`, then `npm run release:publish`.

**Total estimate:** ~12 working days for one engineer, ~7 with parallel tracks (Phases 2/3/4/5 are independent after Phase 1).

---

## 7. Test plan

### 7.1 Unit
- Provider contract tests parameterized over every provider for: capability flags shape, dynamic-flag changes when env shifts, error-message mapping, args composition.
- Cookie store: env permutations (file present/missing, `--cookies-from-browser` set/unset, both set, unreadable file → graceful error).
- Web-search providers: mocked HTTP fixtures for Brave/SerpAPI; HTML fixtures for DuckDuckGo-lite; selector precedence.
- STT providers: pre-canned audio fixtures (≤5s WAV checked into `src/test/fixtures/audio/`); mocked Gemini SDK calls and mocked OpenAI HTTP calls.
- Freshness/JS-runtime: deterministic clock injection.
- Redactor: feeds known cookies/keys through every output surface (provenance, failures, error messages, doctor report) and asserts no leakage.

### 7.2 Schema/migration
- Existing `media-store.test.ts` already covers source columns; extend with a regression that loads a pre-migration manifest fixture and asserts `sourcePlatform` becomes `"youtube"` for legacy rows.
- KB migration test does the same for the transcript KB.
- `mcp-server.test.ts` legacy tool list assertion remains green AND a second assertion validates the new tools are present and have the expected required fields.

### 7.3 Integration (still hermetic — yt-dlp mocked)
- `searchVideoSources` against a query that should hit YouTube native + web-search fallback for x/instagram/tiktok; assert merged canonical results.
- `importVideoSources` for one URL per platform with a stub yt-dlp returning a tiny canned mp4; assert media manifest rows + visual-index rows.

### 7.4 Live smoke matrix (manual, gated by `npm run smoke -- --live`)
| Platform | Sample input | Expected |
|---|---|---|
| YouTube public URL | `https://youtu.be/dQw4w9WgXcQ` | inspect, import, transcript, visual index |
| YouTube post-update | rerun above after `update-deps` | unchanged |
| X public post | a known public-status URL with video | inspect, import (or `auth required` if blocked), visual index |
| X with cookies | same URL with `VIDLENS_X_COOKIES_FILE` | reliable import |
| Instagram public reel | a known public reel | best-effort import; clear `auth required` if blocked |
| Instagram with cookies | same reel | reliable import |
| TikTok public URL | a known public TikTok | import + visual index |
| Generic URL | a Vimeo embed page | best-effort import |
| Local mp4 | a small test clip | copy + visual index |
| Cross-platform visual search | mixed corpus | search returns frames from ≥2 platforms |
| STT round trip (Gemini) | imported TikTok | transcript present in KB |

### 7.5 Privacy regression
A dedicated test seeds a synthetic cookie file, runs every public MCP method that touches yt-dlp, and asserts the cookie value never appears in any returned object or error message.

---

## 8. Backwards compatibility contract

- **Tool names.** Every entry of the existing `tools` array in `src/server/mcp-server.ts` remains. New tools are additive only. `src/test/mcp-server.test.ts` keeps the existing assertion.
- **Schemas.** `videoIdOrUrl` continues to accept bare YouTube IDs and URLs in all tools. `findVideos`, `inspectVideo`, `inspectChannel`, `readTranscript`, `readComments`, `exploreYouTube` remain YouTube-only with their current shapes.
- **Storage.** All schema migrations are additive (`addColumnIfMissing` pattern from `media-store.ts:124`) and idempotent. Pre-migration data loads cleanly with `sourcePlatform="youtube"` backfilled.
- **Env vars.** All new env vars are optional. Absence of cookies/keys downgrades gracefully — never errors.
- **Capability flags.** `VideoSourceCapabilities.transcript` remains boolean in `1.3.0`; callers that want detail can read the additive `transcriptMode?: "native"|"stt"|"unsupported"` field. Document in CHANGELOG.
- **Transcript search URLs.** Existing YouTube `timestampUrl` behavior remains unchanged. Non-YouTube rows use source-aware canonical URLs and do not fabricate `youtu.be` links.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| yt-dlp's TikTok/IG extractors break upstream | High | Tool returns errors | Freshness diagnostics; `update-deps` CLI; clear error mapping |
| Instagram/X reject unauthenticated requests | High | Default flow fails | Honest `auth required` capability; cookie path; documented in setup |
| DuckDuckGo HTML scrape breaks | Medium | Fallback discovery dies | Mark best-effort; precedence places it last; users with API keys unaffected |
| Whisper.cpp latency on long videos | Medium | UX feels slow | Chunking; per-chunk progress notifications where supported; recommend Gemini STT for long videos |
| MCP clients without progress support make long STT look idle | Medium | Poor UX | Always return final chunk counts; emit progress only when the client supplies a progress token; document synchronous runtime |
| Cookie-file leakage into logs/responses | Low | Privacy breach | Redactor utility + dedicated regression test |
| Codex Desktop plugin loader changes | Medium | Plugin install breaks | Pin to current `.codex-plugin/plugin.json` schema; document version in `install.md` |
| Provider abstraction introduces regressions in YouTube path | Medium | Existing users affected | Phase 1 keeps YouTube provider behaviorally identical; full existing test suite must remain green |
| TOML serializer for Codex setup | Low | New dep or hand-rolled | Hand-roll a tiny serializer (Codex config is simple); avoids new dep |
| Network-dependent freshness check in CI | Low | Flaky tests | Always testable with `--no-live`; live-only behind env flag |

---

## 10. Rollout

1. Land Phase 1 (provider abstraction) behind no flag — pure refactor; merge after green CI.
2. Land Phases 2–6 in any order; each behind no flag; merge incrementally.
3. Land Phase 7 (KB migration) — release-note the migration explicitly.
4. Land Phase 8 (universal explore) behind `VIDLENS_ENABLE_UNIVERSAL_EXPLORE=1`.
5. Land Phase 9 (smoke + plugin install).
6. Cut `1.3.0`. Promote `VIDLENS_ENABLE_UNIVERSAL_EXPLORE` to default-on in `1.4.0` after one release of real-world feedback.

Versioning: SemVer. `1.3.0` is minor because every public schema change is additive and migrations are backward-compatible. Do not replace boolean capability fields in this release.

---

## 11. Decisions (locked in 2026-05-09)

1. **OpenAI Whisper:** include in 1.3.0 using the latest OpenAI audio API (`POST /v1/audio/transcriptions`, current preferred model — verify the model name at impl time and pin via env `VIDLENS_OPENAI_STT_MODEL`, default to whatever OpenAI lists as their newest transcription model on the date the work begins). No new SDK dep; bare `fetch`.
2. **Managed Deno install:** auto-download during `setup`, mirroring `ytdlp-installer.ts`. ~50MB one-time cost on first run is acceptable for the YouTube extractor reliability win.
3. **`transcribeVideoSource` MCP tool:** **expose both surfaces**. (a) Standalone tool `transcribeVideoSource(source, options)` for re-transcription, language switches, and "I already imported it" flows. (b) Convenience flag on `importVideoSources({ transcribe: true })` for one-shot import-and-transcribe. This mirrors the existing `importVideoSources({ indexVisualContent: true })` ↔ standalone `indexVisualContent` symmetry, so Claude/Codex have a single mental model: every "do X to a video" verb has both a one-shot and a standalone form.
4. **`VIDLENS_WEB_SEARCH_PROVIDER`:** add as an opt-in override. Values: `auto` (default; key-presence precedence chain Brave → SerpAPI → DuckDuckGo-lite), `brave`, `serpapi`, `duckduckgo`, `none` (disables web-search fallback entirely). Auto-mode behavior is documented in §4.3.
5. **Web-search provider lineup:** Brave Search API (primary, 2,000 free queries/month), SerpAPI (paid power-user option), DuckDuckGo-lite (no-key fallback). **Perplexity API explicitly skipped** — it is an answer engine, not a search engine; for URL discovery we'd be paying for LLM synthesis we don't want, then parsing URLs out of prose. Perplexity slots in cleanly later as another `WebSearchProvider` if there's demand. Tracked as future work for 1.4.
6. **Codex Desktop config (verified 2026-05-09):** target `~/.codex/config.toml`. Layout observed on this machine:
   - `[mcp_servers.<name>]` blocks for MCP servers (the existing repo `.codex/config.toml` already uses this shape).
   - `[marketplaces.<name>]` with `source_type = "local"|"git"` for plugin discovery.
   - `[plugins."<plugin>@<marketplace>"] enabled = true` for plugin enablement.
   - App bundle: `/Applications/Codex.app`. App support: `~/Library/Application Support/Codex/`. CLI binary: `codex` on PATH (`codex-cli 0.118.0` at the time of writing).
   - Setup wizard for Codex must merge into existing TOML (preserve unrelated blocks). Hand-rolled minimal TOML serializer is sufficient — the surface we touch is dotted-key tables only.
7. **STT length cap:** none. No hard cap on video length. Implementation must chunk transparently (silence-detect via ffmpeg, fall back to fixed windows), emit MCP progress notifications when supported, and always include final chunk counts in the tool response. Users opt into STT explicitly, so any cost is intentional.
8. **Capability compatibility:** keep `VideoSourceCapabilities.transcript` boolean in `1.3.0`; add `transcriptMode` instead of changing the field type.
9. **Transcript URL correctness:** cross-platform transcript search must carry `canonical_url` through the KB and must not build YouTube timestamp URLs for non-YouTube rows.

## 11a. Future work (deferred past 1.3.0)

- Perplexity Search API as an additional `WebSearchProvider`.
- `searchVideoSourcesAcrossKb` cross-collection semantic search.
- Promote `findSourcedVideos` / `exploreSourcedVideos` to default-on.
- Native Twitter/X API integration if/when API access becomes practical.

---

## 12. References

- yt-dlp cookies: https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
- yt-dlp `--cookies-from-browser`: https://github.com/yt-dlp/yt-dlp#filesystem-options
- yt-dlp extractor args: https://github.com/yt-dlp/yt-dlp#extractor-arguments
- yt-dlp JS runtime issue: https://github.com/yt-dlp/yt-dlp/issues/15012
- yt-dlp releases (freshness): https://github.com/yt-dlp/yt-dlp/releases
- Brave Search API: https://brave.com/search/api/
- SerpAPI: https://serpapi.com/
- Gemini audio understanding: https://ai.google.dev/gemini-api/docs/audio
- Whisper.cpp: https://github.com/ggerganov/whisper.cpp
- OpenAI Whisper API: https://platform.openai.com/docs/guides/speech-to-text
- Deno releases: https://github.com/denoland/deno/releases
- Apple Vision text recognition: https://developer.apple.com/documentation/vision/recognizing-text-in-images
- Apple Vision feature prints: https://developer.apple.com/documentation/vision/vngenerateimagefeatureprintrequest
- Superpowers methodology: https://github.com/obra/superpowers
- Companion plan: `plans/2026-05-09-codex-plugin-universal-video.md`
