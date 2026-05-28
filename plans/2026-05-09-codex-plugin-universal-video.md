# VidLens Codex Plugin + Universal Video Plan

## Summary

Create a sibling worktree at `/Users/rajan/Dropbox/Projects/VidLens-codex-plugin` on branch `codex/codex-plugin-universal-video`.

Build VidLens into a local Codex plugin for macOS Desktop and Codex CLI while expanding the MCP from YouTube-only intelligence into universal video intelligence across YouTube, X/Twitter, Instagram, TikTok, generic URLs, and local video files.

The universal video features must work through the core MCP server for both Claude and Codex. Codex plugin packaging is an additional distribution surface, not a forked feature path.

## Key Changes

- Add a Codex plugin bundle under `plugins/vidlens/` with `.codex-plugin/plugin.json`, `.mcp.json`, `skills/`, and assets.
- Add `.agents/plugins/marketplace.json` for local Codex plugin testing and future GitHub/npm marketing.
- Keep `vidlens-mcp` as the npm/package/server name; update positioning from "YouTube as a queryable database" to "video as a queryable local asset."
- Preserve Claude MCP compatibility:
  - keep `vidlens-mcp serve`
  - keep existing Claude Desktop and Claude Code setup paths
  - keep existing YouTube tool names as compatibility aliases
  - expose every new universal video capability through the same MCP tools Claude can call
  - add regression tests so Claude config and MCP schemas do not break.
- Use the Superpowers build discipline from https://github.com/obra/superpowers:
  - keep this design document as the source of truth
  - split implementation into small, verifiable tasks before coding
  - use red/green/refactor TDD for parser, adapter, migration, and MCP behavior
  - verify each batch before moving on.
- Refactor the current YouTube service into provider adapters:
  - `youtube`, `x`, `instagram`, `tiktok`, `generic_url`, `local_file`
  - each adapter exposes capability flags for search, download, transcript, comments, thumbnails, auth, and live support.
- Make YouTube support update-resilient:
  - keep managed `yt-dlp` detection/update flow
  - add `yt-dlp` version/channel diagnostics
  - detect the external JavaScript runtime requirement for full YouTube support
  - prefer managed Deno support on macOS, with Node fallback only when explicitly configured.
- Use Gemini as a provider abstraction:
  - default Gemini embeddings to the current stable `gemini-embedding-001`
  - keep the embedding model configurable through environment variables so future Gemini embedding releases can be adopted without schema churn
  - preserve existing Gemini key handling and redaction.
- Keep Apple local fallbacks source-agnostic:
  - download or ingest any video
  - extract frames with ffmpeg
  - run Apple Vision OCR and image feature prints on frames
  - keep this pipeline valid for YouTube and all new platforms.
- Support "all of the above" platform search:
  - provider-native search where available
  - web-search URL discovery fallback
  - local indexed-asset search
  - clear provenance and honest unsupported/auth-required states.
- Add optional user-provided auth:
  - public content works first
  - optional cookies/API tokens for X, Instagram, TikTok
  - never expose cookies, tokens, or raw secrets in logs, MCP responses, reports, or tests.

## Interface Changes

- Generalize media identity from `videoId` to `assetId` plus source metadata:
  - `sourcePlatform`
  - `sourceUrl`
  - `sourceId`
  - `canonicalUrl`
  - `title`
  - `creator`
  - `durationSec`
  - `localFiles`
- Keep old YouTube records readable through migration.
- Add universal tool names while retaining old YouTube names as aliases:
  - `findVideos` can remain but should delegate to universal search
  - add `searchVideoSources`
  - add `importVideoSources`
  - keep `downloadAsset`, `indexVisualContent`, and `searchVisualContent` source-agnostic.
- Update `doctor` and `setup` to explicitly report:
  - Codex CLI config
  - Codex Desktop/plugin readiness
  - Claude MCP compatibility
  - Claude Desktop and Claude Code access to universal video tools
  - yt-dlp freshness
  - Deno/JS runtime readiness for YouTube
  - Gemini embedding model availability
  - Apple Vision availability on macOS.

## Test Plan

- Unit tests for parsing YouTube, X/Twitter, Instagram, TikTok, generic URLs, and local file paths.
- Provider adapter contract tests for capability flags, auth-required states, unsupported states, and provenance.
- Migration tests proving old YouTube collections and media rows still load.
- MCP schema tests proving old Claude-facing tools still exist.
- Claude parity tests proving universal video tools are available through plain MCP stdio, independent of Codex plugin installation.
- CLI tests for:
  - `setup --client codex --print-only`
  - `doctor --no-live`
  - Claude Desktop/Claude Code config inspection
  - redacted keys and auth paths.
- Plugin tests:
  - plugin manifest loads
  - `.mcp.json` starts `vidlens-mcp serve`
  - Codex CLI sees the MCP server
  - local Codex Desktop can install/enable the plugin.
- Live/manual smoke matrix:
  - YouTube public URL
  - YouTube URL after managed yt-dlp update
  - X/Twitter public URL
  - Instagram public URL with and without cookies
  - TikTok public URL
  - local `.mp4`
  - visual search across imported mixed-platform assets.

## Assumptions

- The worktree will live as a Dropbox sibling because that is the chosen location.
- Distribution target is GitHub and npm first, with Codex plugin metadata in-repo.
- VidLens remains the product name.
- Claude Desktop and Claude Code remain first-class MCP clients; no universal video feature is Codex-only.
- Gemini embedding support remains valid through the stable `gemini-embedding-001` model and a configurable model override for future Gemini releases.
- Apple Vision remains the local macOS fallback for OCR and image similarity because it works on extracted frames, independent of source platform.
- YouTube support must include dependency freshness because `yt-dlp` can break when YouTube changes externally and newer YouTube extraction may require a JavaScript runtime.

## References

- Gemini embeddings: https://ai.google.dev/gemini-api/docs/embeddings
- yt-dlp releases: https://github.com/yt-dlp/yt-dlp/releases
- yt-dlp JavaScript runtime announcement: https://github.com/yt-dlp/yt-dlp/issues/15012
- Apple Vision text recognition: https://developer.apple.com/documentation/vision/recognizing-text-in-images
- Apple Vision feature prints: https://developer.apple.com/documentation/vision/vngenerateimagefeatureprintrequest
- Superpowers methodology: https://github.com/obra/superpowers
