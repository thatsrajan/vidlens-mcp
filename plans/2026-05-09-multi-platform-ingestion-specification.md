# Multi-Platform Ingestion Implementation Specification

**Date:** 2026-05-09
**Release target:** `vidlens-mcp@1.3.0`
**Branch:** `codex/codex-plugin-universal-video`
**Source plan:** `plans/2026-05-09-multi-platform-ingestion-completion.md`

This specification turns the completion plan into an executable build contract. Follow it in order unless a test failure proves a dependency needs to move earlier.

---

## 1. Product Contract

VidLens 1.3.0 must support YouTube, X/Twitter, Instagram, TikTok, generic URLs, and local video files through the same MCP server used by Claude and Codex.

The release is production-grade when a user can:

1. Resolve any supported source into canonical source metadata.
2. Discover YouTube natively and discover social/generic URLs through configurable web search.
3. Import URLs and local files into the media store with source metadata preserved.
4. Visually index every imported source.
5. Optionally transcribe non-YouTube sources through STT and search those transcripts later.
6. Diagnose platform, auth, yt-dlp, JS runtime, STT, web-search, and Codex registration readiness.
7. Run hermetic CI tests without live network access.

---

## 2. Compatibility Requirements

These are non-negotiable for 1.3.0:

- Do not remove or rename existing MCP tools.
- Keep YouTube-specific tools YouTube-shaped: `findVideos`, `exploreYouTube`, `inspectVideo`, `readTranscript`, `readComments`, and related channel tools remain compatible.
- Keep `VideoSourceCapabilities.transcript` as `boolean`.
- Add `VideoSourceCapabilities.transcriptMode?: "native" | "stt" | "unsupported"` for detail.
- Keep `SearchVideoSourcesOutput.searched[].mode` values compatible. Use existing `"web_fallback"` for web search and add `providerId?: WebSearchProviderId`.
- All schema migrations must be additive and idempotent.
- Legacy YouTube KB and media rows must backfill to `source_platform = "youtube"`.
- `searchTranscripts` must not fabricate YouTube URLs for non-YouTube rows.
- New env vars are optional. Missing cookies, API keys, STT, or web-search providers degrade gracefully.
- Secret values must not appear in MCP responses, thrown errors, doctor/setup output, provenance, or logs.
- Release version must be updated in `package.json`, `server.json`, `server.json.packages[].version`, `plugins/vidlens/.codex-plugin/plugin.json`, and MCP server metadata in `src/server/mcp-server.ts`.

---

## 3. Public Type Changes

### 3.1 Video Source Capabilities

```ts
export interface VideoSourceCapabilities {
  search: "native" | "web_fallback" | "local_index" | "unsupported";
  inspect: boolean;
  download: boolean;
  transcript: boolean;
  transcriptMode?: "native" | "stt" | "unsupported";
  comments: boolean;
  thumbnail: boolean;
  visualIndex: boolean;
  requiresAuth: boolean;
  authModes: Array<"none" | "cookies" | "api_key">;
  notes: string[];
}
```

Semantics:

- `transcript: true` means a transcript path is available in the current runtime.
- `transcriptMode: "native"` means platform captions or existing VidLens YouTube transcript logic.
- `transcriptMode: "stt"` means an STT provider is configured and can create a transcript from audio.
- `transcriptMode: "unsupported"` means no transcript path is currently available.

### 3.2 Search Video Sources

`SearchVideoSourcesOutput.searched[]` keeps the existing `mode` union and adds an optional provider id:

```ts
searched: Array<{
  platform: VideoSourcePlatform | "local_assets";
  mode: "native" | "web_fallback" | "local_index" | "unsupported";
  providerId?: "brave" | "serpapi" | "duckduckgo_lite";
  status: "ok" | "partial" | "skipped";
  detail: string;
}>;
```

### 3.3 Transcript Search Results

`SearchTranscriptsOutput.results[]` keeps existing fields and adds source metadata:

```ts
results: Array<{
  collectionId: string;
  videoId: string;
  videoTitle: string;
  channelTitle?: string;
  sourcePlatform?: VideoSourcePlatform;
  sourceId?: string;
  canonicalUrl?: string;
  chunkText: string;
  tStartSec: number;
  tEndSec?: number;
  timestampUrl: string;
  score: number;
  lexicalScore?: number;
  semanticScore?: number;
  context?: {
    prevChunkText?: string;
    nextChunkText?: string;
  };
}>;
```

Timestamp URL rules:

- YouTube rows keep `https://youtu.be/<videoId>?t=<seconds>`.
- X, Instagram, TikTok, and generic URL rows use `canonicalUrl` and append a timestamp only where that platform URL format is known to support one.
- Local files use the file URL canonical form and do not pretend to be seekable in a browser unless a real local playback URL exists.

### 3.4 Transcription Tool

Add MCP tool `transcribeVideoSource`.

Input:

```ts
export interface TranscribeVideoSourceInput extends TokenControls {
  source: string;
  language?: string;
  sttProvider?: "whisper-cpp" | "gemini" | "openai" | "auto";
  forceReindex?: boolean;
  collectionId?: string;
  activateCollection?: boolean;
}
```

Output:

```ts
export interface TranscribeVideoSourceOutput {
  source: VideoSourceSummary;
  transcript: {
    videoId: string;
    languageUsed?: string;
    sourceType: TranscriptRecord["sourceType"];
    confidence?: number;
    transcriptCharacters: number;
    segmentCount: number;
    chunksProcessed: number;
    totalChunks: number;
  };
  collectionId?: string;
  activeCollectionId?: string;
  durationMs: number;
  provenance: Provenance;
}
```

`importVideoSources` also gains `transcribe?: boolean` and calls the same core helper.

---

## 4. Internal Modules

### 4.1 Providers

Create `src/lib/providers/`.

Required files:

- `types.ts`
- `registry.ts`
- `youtube-provider.ts`
- `x-provider.ts`
- `instagram-provider.ts`
- `tiktok-provider.ts`
- `generic-url-provider.ts`
- `local-file-provider.ts`

Provider interface:

```ts
export interface VideoProvider {
  readonly platform: VideoSourcePlatform;
  capabilities(ctx: ProviderContext): VideoSourceCapabilities;
  inspect(ref: VideoSourceRef, ctx: ProviderContext): Promise<ProviderInspectResult>;
  download(ref: VideoSourceRef, opts: ProviderDownloadOptions, ctx: ProviderContext): Promise<ProviderDownloadResult>;
  transcribe?(ref: VideoSourceRef, opts: ProviderTranscribeOptions, ctx: ProviderContext): Promise<TranscriptRecord>;
  comments?(ref: VideoSourceRef, ctx: ProviderContext): Promise<CommentRecord[]>;
  searchByQuery?(query: string, opts: ProviderSearchOptions, ctx: ProviderContext): Promise<SearchItem[]>;
}
```

Provider context must inject dependencies. Providers must not read `process.env` directly.

Context includes:

- `ytDlpBinary`
- `mediaStore`
- `dataDir`
- `cookieStore`
- `webSearch`
- `stt`
- `redactor`
- `progressReporter`

### 4.2 yt-dlp Execution

Create one shared yt-dlp execution helper used by URL-backed providers.

Responsibilities:

- Compose args from provider, format, cookies, extractor args, JS runtime env, output template, and size limits.
- Redact stdout/stderr before returning or throwing.
- Map common extractor/auth/rate-limit errors into clear messages.
- Preserve the current YouTube behavior for existing flows.

### 4.3 Cookies

Create `src/lib/auth/cookie-store.ts`.

Resolution order:

1. Platform-specific cookie file if env var is set and readable.
2. `VIDLENS_COOKIES_FROM_BROWSER` plus optional `VIDLENS_COOKIES_PROFILE`.
3. No cookies.

Cookie env vars:

- `VIDLENS_YOUTUBE_COOKIES_FILE`
- `VIDLENS_X_COOKIES_FILE`
- `VIDLENS_INSTAGRAM_COOKIES_FILE`
- `VIDLENS_TIKTOK_COOKIES_FILE`
- `VIDLENS_COOKIES_FROM_BROWSER`
- `VIDLENS_COOKIES_PROFILE`

Cookie file paths may appear in doctor/setup output. Cookie file contents and cookie header values must never appear.

### 4.4 Web Search

Create `src/lib/web-search/`.

Required files:

- `types.ts`
- `selector.ts`
- `brave-provider.ts`
- `serpapi-provider.ts`
- `duckduckgo-lite-provider.ts`

Selection:

- `VIDLENS_WEB_SEARCH_PROVIDER=auto|brave|serpapi|duckduckgo|none`
- Auto precedence: Brave if `BRAVE_API_KEY`, then SerpAPI if `SERPAPI_KEY`, then DuckDuckGo-lite.
- `none` disables non-YouTube URL discovery and keeps the current skipped guidance.

`searchVideoSources` uses site-restricted queries per platform, then validates every URL with `resolveVideoSource`.

### 4.5 STT

Create `src/lib/stt/`.

Required files:

- `types.ts`
- `selector.ts`
- `chunker.ts`
- `whisper-cpp-provider.ts`
- `gemini-stt-provider.ts`
- `openai-whisper-provider.ts`

Selection:

- `VIDLENS_STT_PROVIDER=auto|whisper-cpp|gemini|openai|none`
- Auto precedence: whisper-cpp if binary and model are present, then Gemini if `GEMINI_API_KEY` or `GOOGLE_API_KEY`, then OpenAI if `OPENAI_API_KEY`, then none.
- `VIDLENS_STT_LANGUAGE_HINT` provides a default language.
- `VIDLENS_WHISPER_MODEL_PATH` points to the local whisper.cpp model file.
- `VIDLENS_GEMINI_STT_MODEL` and `VIDLENS_OPENAI_STT_MODEL` override provider models.

Implementation rules:

- Do not hard-code a future-sensitive OpenAI model name in this spec. Verify official OpenAI docs at implementation time and keep the env override.
- Chunk long audio by silence when possible, fixed windows otherwise.
- Preserve absolute timestamps when stitching chunks.
- Expose final `chunksProcessed` and `totalChunks`.
- Emit MCP progress updates when supported.

Local files:

- Copy video into the media store first.
- Extract audio with ffmpeg for STT.
- Register the audio asset.
- Never mutate or delete the original local file.

### 4.6 Progress

Create `src/lib/progress.ts`.

Minimal internal interface:

```ts
export interface ProgressReporter {
  report(event: {
    phase: string;
    current: number;
    total?: number;
    message?: string;
  }): Promise<void> | void;
}
```

`mcp-server.ts` adapts MCP progress-token support into this interface. Service and provider code only depend on the internal reporter.

### 4.7 Knowledge Base

Update `src/lib/knowledge-base.ts`.

Schema additions on `collection_videos`:

- `source_platform TEXT`
- `source_id TEXT`
- `canonical_url TEXT`

Migration:

- Add columns if missing.
- Backfill null source platform to `youtube`.
- Backfill null canonical URL from the existing YouTube video id.

Search:

- `SearchRow` must include source metadata.
- Search results must include source metadata.
- Timestamp URL builder must be source-aware.

### 4.8 Diagnostics and Setup

Add diagnostics:

- yt-dlp date freshness.
- latest upstream release check when live checks are enabled.
- Deno/Node JS runtime detection.
- managed Deno installer.
- platform readiness rows.
- cookie/auth state with paths only.
- STT readiness.
- web-search readiness.
- Codex CLI/Desktop registration.

CLI changes:

- `vidlens-mcp update-deps`
- `vidlens-mcp setup --client codex`
- `vidlens-mcp setup --print-only`
- `vidlens-mcp doctor --platform <platform>`
- `vidlens-mcp doctor --no-live`

Setup wizard contract:

- First-run setup must be a complete guided path, not a partial config generator. It prompts for YouTube, Gemini, OpenAI, Brave/SerpAPI, STT provider, language hint, whisper.cpp model path, web-search provider, browser-cookie source/profile, and platform-specific cookie files.
- Every prompted value must also have a non-interactive CLI flag for repeatable installs and CI/dev setup.
- Generated MCP env blocks for Claude Desktop, Claude Code, and Codex must include the same universal ingestion settings.
- `--print-only` must show which env keys would be configured while redacting API key values. Cookie file paths may be shown; cookie contents must never be shown.
- `npm install -g vidlens-mcp` may print the next setup command, but must not collect secrets during package install. Credential collection belongs in `vidlens-mcp setup`.

Codex config target:

- `~/.codex/config.toml`
- Preserve unrelated TOML blocks.
- Use a minimal serializer only for the simple tables this setup flow writes.

### 4.9 Plugin Distribution

Update `plugins/vidlens/.mcp.json` to support development and release execution.

Required behavior:

- Dev profile runs local checkout build.
- Release profile runs `npx -y vidlens-mcp serve`.
- `plugins/vidlens/install.md` explains the split.
- `.agents/plugins/marketplace.json` remains valid for local Codex plugin testing.

---

## 5. Execution Order

### Phase 0 - Baseline

Run and record:

```sh
npm test
npm run build
```

Do not fix unrelated failures unless they block the new work. Document any baseline failure before coding.

### Phase 1 - Compatibility Types and Progress Shell

Implement:

- Add `transcriptMode` types.
- Add source-aware transcript output fields.
- Add web-search `providerId`.
- Add `TranscribeVideoSourceInput/Output`.
- Add `ProgressReporter`.
- Add MCP server metadata version source or update path.

Tests:

- MCP schema includes new fields/tool.
- Existing MCP tool list remains intact.
- Type-level or runtime assertions cover boolean `transcript` compatibility.

### Phase 2 - Provider Registry

Implement:

- Provider interfaces and registry.
- Extract local-file copy behavior into provider.
- Extract URL download behavior into provider helper.
- Route `downloadAsset`, `importVideoSources`, `inspectVideoSource`, and `searchVideoSources` through providers where practical.

Tests:

- Contract tests for every provider.
- YouTube provider path preserves current behavior.
- Local-file provider copies and registers media.

### Phase 3 - Cookies and Redaction

Implement:

- Cookie store.
- Redactor.
- Provider cookie args.
- Error mapping and redaction in all public output paths.

Tests:

- Cookie env matrix.
- Unreadable cookie path returns clear diagnostic.
- Synthetic cookie values never appear in responses/errors/log-shaped strings.

### Phase 4 - Web Search

Implement:

- Web-search provider selector.
- Brave provider.
- SerpAPI provider.
- DuckDuckGo-lite provider.
- Site-restricted search in `searchVideoSources`.

Tests:

- Mocked HTTP for Brave and SerpAPI.
- HTML fixture for DuckDuckGo-lite.
- Selector precedence.
- Canonical URL validation through `resolveVideoSource`.

### Phase 5 - STT and Transcription Tool

Implement:

- STT provider selector.
- Chunker.
- Whisper.cpp provider.
- Gemini provider.
- OpenAI provider via bare fetch.
- Local-file audio extraction.
- `transcribeAsset`.
- `transcribeVideoSource`.
- `importVideoSources({ transcribe: true })`.
- Progress reporter plumbing.

Tests:

- Provider selector env matrix.
- Chunk stitching.
- Local mp4 to audio asset.
- Progress reporter receives chunk updates.
- Standalone and one-shot MCP schemas.
- Dry-run behavior.

### Phase 6 - KB Source Awareness

Implement:

- KB migration.
- Source metadata persistence.
- Non-YouTube transcript import.
- Source-aware transcript search result URLs.

Tests:

- Legacy YouTube rows backfill.
- New social/local rows persist source metadata.
- Non-YouTube transcript search does not return `youtu.be`.
- Existing KB tests still pass.

### Phase 7 - Diagnostics, Setup, and Update Deps

Implement:

- yt-dlp freshness.
- JS runtime detection.
- managed Deno installer.
- `update-deps`.
- expanded doctor.
- Codex setup and TOML writer.

Tests:

- Deterministic date/freshness checks.
- Mocked runtime detection.
- `doctor --no-live` does not fetch network.
- `setup --client codex --print-only` emits valid expected TOML.

### Phase 8 - Universal Find/Explore

Implement behind `VIDLENS_ENABLE_UNIVERSAL_EXPLORE=1`:

- `findSourcedVideos`
- `exploreSourcedVideos`

Tests:

- Tools absent or inert when flag is off, depending on chosen MCP registration pattern.
- Tools available and route through source search when flag is on.

### Phase 9 - Plugin Distribution and Smoke

Implement:

- `.mcp.json` dev/release profiles.
- `plugins/vidlens/install.md`.
- smoke dry-run cases for all non-YouTube platforms and local file.

Tests:

- Plugin manifest loads.
- `.mcp.json` validates.
- `npm run smoke:dry` passes.

### Phase 10 - Release Prep

Implement:

- Version bumps everywhere listed in compatibility requirements.
- README env/auth/STT/Codex setup docs.
- CHANGELOG additive entry.

Verify:

```sh
npm run release:verify
npm pack --dry-run
```

Manual live smoke is required before publish.

---

## 6. Hermetic Test Matrix

Required new/updated tests:

- `src/test/providers/contract.test.ts`
- `src/test/providers/youtube-provider.test.ts`
- `src/test/providers/x-provider.test.ts`
- `src/test/providers/instagram-provider.test.ts`
- `src/test/providers/tiktok-provider.test.ts`
- `src/test/providers/generic-url-provider.test.ts`
- `src/test/providers/local-file-provider.test.ts`
- `src/test/auth/cookie-store.test.ts`
- `src/test/redactor.test.ts`
- `src/test/web-search/selector.test.ts`
- `src/test/web-search/brave-provider.test.ts`
- `src/test/web-search/serpapi-provider.test.ts`
- `src/test/web-search/duckduckgo-lite-provider.test.ts`
- `src/test/stt/selector.test.ts`
- `src/test/stt/chunker.test.ts`
- `src/test/stt/local-file-audio.test.ts`
- `src/test/stt/progress.test.ts`
- `src/test/stt/gemini-stt-provider.test.ts`
- `src/test/stt/openai-whisper-provider.test.ts`
- `src/test/transcribe-video-source.test.ts`
- `src/test/knowledge-base-source-aware.test.ts`
- `src/test/diagnostics/yt-dlp-freshness.test.ts`
- `src/test/diagnostics/js-runtime.test.ts`
- `src/test/toml-writer.test.ts`
- `src/test/cli-doctor-platform.test.ts`
- `src/test/cli-setup-codex.test.ts`
- `src/test/mcp-server.test.ts`
- `src/test/service.dryrun.test.ts`
- `src/test/media-store.test.ts`

Tests must not require live network access. Use fixtures and mocked fetch/execa calls.

---

## 7. Manual Live Smoke Matrix

Run only when intentionally preparing the release:

| Platform | Input | Expected |
|---|---|---|
| YouTube public URL | Known public URL | inspect, import, transcript, visual index |
| YouTube after update-deps | Same URL | unchanged behavior |
| X public post | Known public video post | import or clear auth-required result |
| X with cookies | Same post | reliable import |
| Instagram public reel | Known public reel | import or clear auth-required result |
| Instagram with cookies | Same reel | reliable import |
| TikTok public URL | Known public TikTok | import and visual index |
| Generic URL | Vimeo or direct mp4 page | best-effort import |
| Local mp4 | Small fixture clip | copy, visual index, STT if provider configured |
| Cross-platform visual search | Mixed corpus | returns frames from at least two platforms |
| STT round trip | Imported social/local asset | transcript present and searchable |

Record live smoke results in the release notes or release checklist before publishing.

---

## 8. Done Criteria

The implementation is complete when:

- `npm test` passes.
- `npm run release:verify` passes.
- `npm run smoke:dry` passes.
- `doctor --no-live` reports new readiness sections without network.
- `inspectVideoSource` remains backward compatible and includes `transcriptMode`.
- `searchVideoSources` can return web-search-discovered canonical social URLs when configured.
- `importVideoSources` can import URL and local-file sources.
- `transcribeVideoSource` works for at least one mocked URL source and one local-file source in tests.
- `searchTranscripts` returns source-correct metadata and URLs for non-YouTube transcripts.
- Secrets redaction tests cover successful and failing provider paths.
- Plugin dev and release install paths are documented.
- The release version is consistent across package, server, plugin, and MCP metadata.
