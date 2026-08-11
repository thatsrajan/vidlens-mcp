---
name: vidlens
description: Use VidLens when the user asks to search, inspect, import, download, index, or visually search videos from YouTube, X/Twitter, Instagram, TikTok, generic URLs, or local video files.
---

# VidLens

Use the VidLens MCP tools for video intelligence work:

- Use `inspectVideoSource` first when the input could be a YouTube ID, social video URL, generic URL, or local video file.
- Use `searchSocialTrends` when the user wants to search social platforms for trends, posts, reels, or cross-platform signal around a topic.
- Use `searchVideoSources` for discovery. It searches YouTube natively, local assets locally, and explains fallback paths for social/web platforms.
- Use `importVideoSources` to store one or more URLs or local files as local VidLens assets.
- Use `downloadAsset` for explicit storage of a video/audio/thumbnail asset without visual indexing.
- Use `indexVisualContent` after import/download to build Apple Vision OCR/similarity and optional Gemini visual embeddings.
- Use `searchVisualContent` when the user asks what was shown in a video, slide, chart, whiteboard, screen recording, or local clip.

## Latest X video workflow

For "creator's latest X video":

1. Call `recallWorkspace` and search existing transcripts/assets first.
2. Resolve the display name to the canonical `@handle`; do not treat the display name as a handle.
3. When `SCRAPECREATORS_API_KEY` is configured, call `searchSocialTrends` for `@handle` with `platforms: ["x"]` and `sort: "recent"`. X is handle/profile retrieval, not general keyword search.
4. If unavailable or incomplete, use `searchVideoSources` for X and public-web discovery to obtain canonical status URLs.
5. Compare timestamps and authors; select the newest original post with playable video, excluding reposts, quoted third-party video, pinned older posts, and text-only posts.
6. Send that exact `x.com/<handle>/status/<id>` URL to `transcribeVideoSource`, then summarize the transcript rather than the caption. Report uncertainty if newest-post verification is incomplete.

The key must be in the running MCP process environment. A repo `.env` does not prove the process inherited it. Never print the key; check presence only, update the MCP launcher env/config if necessary, restart the MCP server/client, and verify again.

Claude Desktop, Claude Code, Codex CLI, and Codex Desktop all call the same MCP server. Do not assume a feature is Codex-only.
