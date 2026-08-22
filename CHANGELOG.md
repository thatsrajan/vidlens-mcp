# Changelog

All notable changes to VidLens MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.5.1] - 2026-08-22

Local cross-client presentation release. VidLens remains a UI-independent MCP server while its
shared workflow now asks capable response surfaces to present every completed analysis as a
polished inline result, for one video or many, without prescribing client-specific tools.
This is the first npm release after `1.4.2`, so npm users upgrade directly from `1.4.2` to `1.5.1`.

### Added
- A simple interactive Free or Enhanced setup choice. Free needs no API keys; Enhanced walks
  through optional services one at a time and masks API-key input in the terminal.
- An outcome-level presentation contract in both distributed `vidlens-workflows` skill layouts,
  including Markdown fallback, provenance, sample-size, freshness, uncertainty, and untrusted-text
  requirements.
- Claude Code setup now installs or updates the bundled workflow skill under the user's Claude
  skills directory, keeping timestamped backups of the three newest replaced copies.
- Regression tests for cross-layout contract parity, client-neutral wording, evidence retention,
  and the managed Claude Code skill installation path.

### Changed
- Codex setup now migrates the old `vidlens` marketplace entry to `vidlens-local` and enables
  `vidlens@vidlens-local`. Existing Codex users should rerun `npx vidlens-mcp setup --client codex`
  after upgrading.
- Replaced the `exploreYouTube` instruction to create named chart forms with portable,
  evidence-preserving presentation guidance.
- Presentation is now independent of video count: the response is polished by default, while the
  evidence shape determines whether a chart, metric view, timeline, comparison, or structured
  Markdown is appropriate.

## [1.5.0] - 2026-08-20

### Added
- A lens-v3 brand system with a new aperture mark, washi-paper visual language, production banners, social artwork, video endcards, and a documented asset guide.
- A compact branded setup banner with truecolor and 256-color terminal support, plus regression coverage for layout, color fallback, and the displayed tool count.
- Lightweight web-ready README and architecture artwork so npm and GitHub render the refreshed documentation without shipping oversized production masters.

### Changed
- Reworked the README around the zero-key starting path, persistent local video library, cross-client workflows, and the existing external visual-evidence gallery.
- Clarified that Codex, Claude, and other capable clients can compose VidLens's structured results into their own native charts, cards, tables, and visual reports.
- `searchVisualContent` is now an explicitly read-only query over an existing visual index. It never downloads or indexes media from the MCP surface; call `indexVisualContent` first when needed.
- VidLens exposes 47 tools across 11 modules.

### Fixed
- Visual-search responses recursively remove local `framePath` fields and `file:` URLs before returning data to an MCP client.

## [1.4.2] - 2026-08-19

This release makes individual social-video research practical without requiring a paid scraper API, while keeping the limits visible. It also refreshes the public documentation and Codex plugin for distribution.

### Added
- A check-first capability ladder for X, Instagram, TikTok, generic video URLs, and local files: reuse the local library first, try an exact public post URL with yt-dlp, use host-level browser assistance for canonical URLs or metadata, then fall back to cookies, local files, or optional APIs when needed.
- Stored social transcripts can be found and reused by their original URL or VidLens asset key, avoiding repeat downloads and transcription.
- Regression coverage for concrete social-post URL validation and stored transcript reuse.

### Changed
- Social-video guidance now distinguishes a visible browser page from an exportable media stream. Browser assistance can recover a canonical URL or useful metadata, but it is not presented as a guaranteed media-download path.
- The Codex plugin uses one portable `npx -y vidlens-mcp serve` configuration, with the same workflow guidance shipped in both Codex and plugin skill layouts.
- Rewrote the README for technical and nontechnical readers, with a clearer zero-key starting path, honest optional-API tradeoffs, and refreshed lens-v3 launch artwork.

### Fixed
- Reject profile, search, explore, and other non-post social URLs before ingestion instead of passing them into opaque downstream failures.
- Persist imported transcript JSON in the media manifest so future sessions can read it directly from the local library.

## [1.4.1] - 2026-07-09

Corruption-proofing release for the media store, driven by a real-world failure on an X video where the audio download overwrote the video asset. Hardened via adversarial cross-model review (5 additional findings fixed).

### Fixed
- **Media store corruption on X/TikTok**: video and audio downloads shared one output path (`{videoId}.%(ext)s`); on platforms where the audio rendition is fMP4 (ext `.mp4`), yt-dlp's resume behavior appended the audio stream onto the completed video file, corrupting both. Downloads are now format-scoped (`{videoId}.{format}.%(ext)s`) so no two formats can ever collide.
- Downloads are validated with ffprobe before entering the manifest; unreadable files are deleted and reported with the real cause instead of poisoning keyframes/STT/duration downstream (validation is skipped only when ffprobe is not installed).
- Corrupt or missing video/audio manifest rows are swept and purged (all rows sharing a file path, including legacy pre-1.4.1 entries with no recorded format) before cache checks, visual indexing, and keyframe extraction — existing corrupted stores self-heal on next use.
- Concurrent downloads of the same video+format (e.g. transcription and visual indexing racing) now share a single in-flight download instead of deleting each other's output.
- Stale leftovers matching a download's output template are removed before yt-dlp runs, including `.chunks/` sidecar directories left by a crashed transcription (previously a permanent hard failure once present).
- Local file ingestion never deletes the user's source file, and self-heals stale corrupt copies by re-copying/re-extracting instead of failing until manual cleanup.
- STT chunker now throws a diagnostic error when audio is over the provider size limit and its duration can't be probed (likely corrupt), instead of sending it to the provider for an opaque API error.
- STT provider-selection errors name the actual gap (missing whisper.cpp binary/model, missing API key) and state explicitly that it's a machine/env configuration issue, not a problem with the video.

## [1.4.0] - 2026-07-08

Full-codebase review and repair release: ~50 findings fixed across every subsystem by a coordinated multi-agent pass, plus a new cross-session memory tool. Test suite grew from ~126 to 402 cases.

### Added
- `recallWorkspace` tool (47th tool): instant digest of everything VidLens already has stored — collections, comment collections, media assets, visual indexes — so agents check existing material before re-importing. Import/download tool descriptions now state that results persist across sessions.
- `vidlens-workflows` agent skill shipped in both Claude (`plugins/vidlens/skills/`) and Codex (`.agents/skills/`) layouts: check-first protocol, read-vs-import guidance, fallback-tier expectations, and the import-back rule for manual downloads.
- README section on persistent memory across sessions and the shared-data-dir pattern (plus a warning against putting `VIDLENS_DATA_DIR` inside Dropbox/iCloud).
- Schema-driven argument validation at the MCP dispatch boundary: enum membership, numeric bounds, required params — invalid input now returns `INVALID_INPUT` with allowed values instead of opaque internal errors.
- SSRF guard (`url-guard`): channel-page fetches and generic-URL downloads reject private/link-local/loopback addresses (escape hatch: `VIDLENS_ALLOW_PRIVATE_URLS=1`).
- yt-dlp installer now verifies the release SHA-256 checksum and installs atomically (temp file + rename); Deno installer gains atomic install and a size cap.
- `setup --yes` flag; non-interactive setup no longer auto-installs software silently (defaults to no).

### Fixed
- **whisper.cpp STT provider was completely non-functional** — now reads the JSON output file (not stdout), parses SRT-style comma timestamps, and converts audio to 16 kHz WAV before transcription. Verified end-to-end against a real `whisper-cli` binary.
- **yt-dlp comment fallback could never return comments** (missing `--write-comments`); comment tools now work without a YouTube API key.
- **Incremental imports no longer destroy Gemini embeddings**: the collection's stored embedding algorithm is authoritative; existing vectors are never silently downgraded to local, and reindexing only embeds new chunks instead of re-billing the whole collection.
- **Re-running `setup` no longer clobbers a custom `VIDLENS_DATA_DIR`** saved in client configs (precedence: flag > saved config > env > default) — protects existing libraries for Claude Desktop, Claude Code, and Codex.
- Schema-migration framework is now actually wired into the knowledge-base, comment, and media stores (was dead code; production DBs never migrated).
- Rate limiter no longer over-admits under concurrency (re-checks after waiting, accumulates fractional refills).
- `checkImportReadiness` and transcript imports now use the same InnerTube-first tier chain as reads — dossiers no longer omit transcripts that `readTranscript` could fetch, and imports work without yt-dlp.
- Background enrichment from `exploreYouTube` is tracked per job: real done/failed status, no duplicate downloads, errors no longer silently swallowed.
- YouTube API pagination: comment and playlist requests above one page (100/50) now paginate to the advertised limits instead of silently truncating.
- Visual search: frame sampling now spreads across the full video duration, fixing permanent re-indexing of videos longer than ~8 minutes on every search; one bad frame no longer aborts the whole indexing batch; non-macOS platforms degrade to Gemini descriptions instead of failing outright.
- Hostname matching uses dot boundaries (`notyoutube.com` no longer routes as YouTube); URL canonicalization preserves query strings for generic URLs.
- STT providers gained retry with backoff and request timeouts; chunker respects provider size caps (bitrate-derived chunk sizing) and cleans up temp chunk directories.
- All raw `fetch` calls now carry timeouts (30s default, 120s downloads).
- Import failure messages are routed through the secret redactor (yt-dlp command lines with cookie paths no longer leak into tool output).
- Media deletes remove manifest rows before files (no more dangling manifest entries on partial failure); asset dedupe distinguishes `best_video`/`worst_video`.
- MCP server reports its real version from package.json (was hardcoded to a stale version); banner tool counts derive from one constant, enforced by a test.
- CLI prints clean one-line messages for usage errors instead of stack traces; `setup --client cursor|vscode` errors clearly instead of silently doing nothing; TOML merge handles commented/spaced table headers without duplicating Codex config tables.
- Invalid `timezone` input to `recommendUploadWindows` returns `INVALID_INPUT` instead of an internal error; `expandPlaylist`'s `includeVideoMeta: false` actually omits metadata; non-YouTube imports no longer fail when `collectionId` is omitted.

### Changed
- ~600 lines of duplicated math/NLP helpers unified into `text-math.ts` (shared by transcript and comment knowledge bases); comment-KB video filtering pushed into SQL.
- `visual-report` opens the browser via argv (no shell) and drops non-http(s) link schemes from reports.

## [1.3.1] - 2026-06-19

### Added
- `searchSocialTrends` for ScrapeCreators-backed social discovery across TikTok, Instagram, Threads, Pinterest, Reddit, and handle-based X lookups.
- `SCRAPECREATORS_API_KEY` setup/config support, plus ScrapeCreators-backed TikTok/Instagram results in `searchVideoSources` when configured.

### Changed
- Improved npm install messaging and package metadata for public npm users.

## [1.3.0] - 2026-05-29

### Added
- Multi-platform source ingestion for YouTube, X/Twitter, Instagram, TikTok, generic URLs, and local video files through one MCP server.
- `transcribeVideoSource` plus `importVideoSources({ transcribe: true })` for native-caption or STT-backed transcript creation.
- Cookie-file/browser-cookie auth plumbing, secret redaction, configurable web-search fallback, and STT provider selection.
- Source-aware transcript search metadata and non-YouTube timestamp URL handling.
- Codex `~/.codex/config.toml` setup, plugin dev/release MCP profiles, yt-dlp freshness diagnostics, JS-runtime diagnostics, and `update-deps`.

## [1.0.27] - 2026-03-19

### Changed
- Lazy-loaded heavy service and media subsystems to reduce cold-start cost for simple MCP sessions
- Added service-boundary caching for repeated metadata, transcript, channel, and comment reads
- Moved transcript `videoIdFilter` work into SQL and added supporting transcript indexes
- Optimized visual search by adding a search-specific row-loading path and query embedding cache
- Reduced npm package payload by excluding compiled tests and source maps from published artifacts

### Fixed
- Visual indexing no longer pays one `ffmpeg` startup per frame on the fast path, with safe fallback to the previous extraction behavior when needed

### Added
- Cache store module (SQLite-backed TTL cache)
- Rate limiter module (token bucket for API quota protection)
- Retry/backoff module (exponential backoff with jitter)
- Schema migration module (PRAGMA user_version)
- Telemetry module (in-memory metrics)
- CI pipeline (GitHub Actions)
- Linter configuration (Biome)
- Graceful shutdown (SIGTERM/SIGINT handling)
- MCP progress notifications for long operations
- Token benchmark CI harness

### Changed
- `vidlens-mcp setup` now auto-configures all 7 MCP clients (Claude Desktop, Claude Code, Cursor, VS Code, ChatGPT Desktop, Codex CLI, Gemini CLI)
- TokenControls (`compact`/`includeRaw`/`fields[]`) wired across all 41 tools
- Import tools now support `minTranscriptQuality` parameter and return `qualityReport`
- All `GracefulError` instances now include `userFriendlyMessage`
- KB responses include `context.scopedBy` field

### Fixed
- ChatGPT Desktop upgraded from manual-copy to full auto-config in setup wizard

## [0.4.0] - 2026-03-15

### Added
- Visual search module: `indexVisualContent`, `searchVisualContent`, `findSimilarFrames` (3 tools)
- Apple Vision OCR and feature print integration (macOS)
- Gemini frame descriptions and semantic embeddings for visual search
- Media assets module: `downloadAsset`, `listMediaAssets`, `removeMediaAsset`, `extractKeyframes`, `mediaStoreHealth` (5 tools)
- Comment KB module: `importComments`, `searchComments`, `listCommentCollections`, `setActiveCommentCollection`, `clearActiveCommentCollection`, `removeCommentCollection` (6 tools)
- Discovery/Trends module: `discoverNicheTrends`, `exploreNicheCompetitors` (2 tools)
- Social preview and branding assets

## [0.3.0] - 2026-03-14

### Added
- Active collection management: `setActiveCollection`, `clearActiveCollection`
- Diagnostics: `checkSystemHealth`, `checkImportReadiness`
- `buildVideoDossier` unified analysis tool
- Creator intelligence: `scoreHookPatterns`, `researchTagsAndTitles`, `compareShortsVsLong`, `recommendUploadWindows`
- CLI commands: `doctor`, `version`, `setup`, `help`
- Client detection for Claude Desktop, Claude Code, Cursor, VS Code, ChatGPT Desktop, Codex
- Startup diagnostics on stderr
- Cross-platform data directory defaults

## [0.2.0] - 2026-03-10

### Added
- Knowledge base: `importPlaylist`, `importVideos`, `searchTranscripts`, `listCollections`, `removeCollection`
- Batch analysis: `analyzeVideoSet`, `analyzePlaylist`
- Sentiment analysis: `measureAudienceSentiment`
- Gemini embedding support (768-dim, `gemini-embedding-2-preview`)
- Local TF-IDF + LSA hybrid search (no API key needed)

## [0.1.0] - 2026-03-07

### Added
- Core tools: `findVideos`, `inspectVideo`, `inspectChannel`, `listChannelCatalog`, `readTranscript`, `readComments`, `expandPlaylist`
- Three-tier fallback chain: YouTube API v3 -> yt-dlp -> page extraction
- Provenance tracking on every response
- Zero-config startup (works without API keys)
- Token-optimized compact responses (75-87% reduction)
