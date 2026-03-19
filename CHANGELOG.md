# Changelog

All notable changes to VidLens MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
