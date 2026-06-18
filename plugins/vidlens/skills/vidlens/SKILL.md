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

Claude Desktop, Claude Code, Codex CLI, and Codex Desktop all call the same MCP server. Do not assume a feature is Codex-only.
