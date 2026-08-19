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

## Social video capability ladder

Use the cheapest available path automatically. An API key is an uplift, not a prerequisite.

1. Call `recallWorkspace` and reuse an existing transcript or media asset.
2. For an exact public X status, Instagram reel/post, or TikTok video URL, call
   `inspectVideoSource`, then `transcribeVideoSource` or `importVideoSources`. VidLens tries
   yt-dlp anonymously first, then configured cookies and local/selected STT.
3. If the user supplied a creator/topic instead of a URL, call `searchVideoSources`. Accept only
   concrete post/video URLs; never pass a profile, explore, hashtag, or popular page to import.
4. If discovery is incomplete or the platform page blocks anonymous inspection, use an available
   Browser/Chrome tool to open the public page or signed-in session and collect the canonical post
   URL plus visible author, caption, date, duration, and engagement. Prefer Browser/Chrome to
   Computer Use because it exposes page structure; use Computer Use only when no browser tool is
   available.
5. Pass the canonical URL back to VidLens. If the browser can legitimately save/download the
   video, import that local file. Do not claim that browser visibility guarantees media export,
   and do not treat a CDN/blob URL as durable provenance.
6. When `SCRAPECREATORS_API_KEY`, Brave, or SerpAPI is configured, use it automatically for scale,
   repeatability, or unattended discovery. Keep the no-key route available for individual videos.

Always report the route used: local reuse, public yt-dlp, browser-assisted, local-file handoff, or
API-enhanced. Browser assistance is orchestrated by the host agent; the MCP server itself does not
control the browser.

## Latest X video workflow

For "creator's latest X video":

1. Call `recallWorkspace` and search existing transcripts/assets first.
2. Resolve the display name to the canonical `@handle`; do not treat the display name as a handle.
3. When `SCRAPECREATORS_API_KEY` is configured, call `searchSocialTrends` for `@handle` with `platforms: ["x"]` and `sort: "recent"`. X is handle/profile retrieval, not general keyword search.
4. If unavailable or incomplete, use `searchVideoSources` for X and public-web discovery to obtain canonical status URLs.
5. Compare timestamps and authors; select the newest original post with playable video, excluding reposts, quoted third-party video, pinned older posts, and text-only posts.
6. Send that exact `x.com/<handle>/status/<id>` URL to `transcribeVideoSource`, then summarize the transcript rather than the caption. Report uncertainty if newest-post verification is incomplete.

The key must be in the running MCP process environment. A repo `.env` does not prove the process inherited it. Never print the key; check presence only, update the MCP launcher env/config if necessary, restart the MCP server/client, and verify again.

Claude Desktop, Claude Code, Codex CLI, and Codex Desktop all call the same MCP server. Browser
availability differs by host, so detect it at runtime rather than assuming every client has one.
