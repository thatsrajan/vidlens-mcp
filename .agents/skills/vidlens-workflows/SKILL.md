---
name: vidlens-workflows
description: Multi-tool workflows and check-first protocol for VidLens video intelligence
metadata:
  tags: vidlens, video, mcp, youtube, transcript, visual-search
---

## When to use

Use this when importing, transcribing, or visually indexing videos through the VidLens MCP
server, or whenever you might re-fetch video material. VidLens imports persist across sessions
and should be reused, not re-imported.

# VidLens workflows

VidLens stores everything on disk under `VIDLENS_DATA_DIR` (SQLite + media files) and that
data **survives across sessions and clients**. Claude Desktop, Claude Code, and Codex all talk
to the same MCP server pointed at the same default data dir, so one agent's imports are visible
to the others. The whole point of VidLens over raw yt-dlp is that imports persist and become
searchable.

## Check-first protocol (do this before any import or download)

1. **`recallWorkspace`** — call this first in a new session. It returns a compact digest of
   every transcript collection, comment collection, media asset, and visual index already
   stored, plus a hint. If what you need is already there, skip straight to search.
2. **`listCollections` / `listCommentCollections` / `listMediaAssets`** — for detail on a
   specific collection or asset.
3. **Search before importing** — `searchTranscripts`, `searchComments`, `searchVisualContent`
   query existing collections instantly. Only import when the material genuinely isn't there.

Re-importing what you already have wastes time and burns API quota.

## Latest video from an X creator

For requests such as "summarize Riley Brown's latest X video":

1. Run `recallWorkspace`, then search existing transcripts/assets for the creator or handle.
   Reuse the exact post if it is already stored.
2. Resolve a display name to the creator's canonical `@handle` from their X profile or a
   reliable web result. Do not pass a display name to X discovery and guess that it is a handle.
3. If ScrapeCreators is configured, call `searchSocialTrends` with `query: "@handle"`,
   `platforms: ["x"]`, `sort: "recent"`, and a suitable freshness window. X support is a
   handle-based profile-tweets endpoint, **not general X keyword search**.
4. If that call is unavailable, partial, or empty, use `searchVideoSources` with the handle,
   creator name, and `platforms: ["x"]`; public web search is also an acceptable discovery
   fallback. Prefer canonical `x.com/<handle>/status/<id>` URLs.
5. Verify "latest" from post timestamps and the profile author. Choose the newest **original
   post containing playable video**, excluding reposts/retweets, replies that merely quote
   another creator's video, pinned older posts, and text-only posts. Say when the evidence is
   incomplete rather than claiming certainty.
6. Pass the selected post's exact status URL to `transcribeVideoSource`, then summarize the
   returned transcript (not just the X caption). Include the post URL and date in the answer.

`SCRAPECREATORS_API_KEY` must be present in the environment of the running MCP server. A value
in the repository `.env` does not guarantee that an already-running Codex/Claude MCP process
inherited it. Check only whether the variable is set, never print or log its value; update the
MCP launcher's env/config if needed, restart the MCP server/client, and verify capability again.

## readTranscript vs importVideos — cheap one-off vs durable library

- **`readTranscript`** — a cheap, one-shot fetch of a single video's transcript. Use when you
  just need to read/quote once and don't need it searchable later.
- **`importVideos` / `importPlaylist`** — durable ingest: chunks the transcript, builds an
  embedding index, and makes it semantically searchable across sessions via `searchTranscripts`.
  Use when the goal is a lasting, queryable video memory or when searching across many videos.
- **`importComments`** does the same for comments (searchable via `searchComments`).
- **`indexVisualContent`** builds a persistent visual index (frames + OCR + optional Gemini
  descriptions/embeddings), queryable via `searchVisualContent`.
- **`renderVideoEvidence`** presents an existing visual search as an inline evidence viewer in
  MCP Apps-capable graphical hosts. Codex CLI and Claude Code receive the same result as structured
  text/JSON, so never treat inline HTML rendering as required for the workflow.

## Fallback tiers — what works without keys, what improves with them

VidLens is designed to work with **zero API keys**:
- **Local reuse:** call `recallWorkspace` first. Previously imported transcripts, media, and visual
  indexes are free and work across clients.
- **No keys:** YouTube uses InnerTube then yt-dlp. Exact public X, Instagram, TikTok, and generic
  video URLs use yt-dlp plus locally available ffmpeg/STT. DuckDuckGo-lite provides best-effort
  discovery and only concrete post/video URLs are accepted.
- **Browser-assisted:** when the host exposes Browser or Chrome control, use it to resolve a
  creator/topic to the canonical post URL and capture visible metadata in a public or user-signed-in
  session. Pass that URL back to VidLens. If a permitted download can be saved locally, import the
  file. Browser visibility does not guarantee automatic media download; Computer Use is a last
  resort when structured browser control is unavailable.
- **Cookies:** configured browser cookies improve yt-dlp access for gated or rate-limited posts.
- **`YOUTUBE_API_KEY`:** higher-fidelity search, richer metadata, reliable comment fetching and
  pagination. Without it, comments fall back to scraping (may return fewer or none).
- **`GEMINI_API_KEY`:** Gemini embeddings for transcript/visual semantic search and Gemini frame
  descriptions (needed for visual descriptions on non-macOS). Without it, transcript embeddings
  are local (LSA) and visual indexing relies on Apple Vision OCR.
- **`OPENAI_API_KEY`:** OpenAI speech-to-text for sources without native captions.
- **`SCRAPECREATORS_API_KEY`:** direct social discovery, including handle-based X profile
  retrieval and paid reliability/scale. Prefer it when configured. Without it, use
  `searchVideoSources`/public-web discovery and transcribe the exact discovered post URL.

Provenance in every tool result reports which tier answered, so degraded answers are visible,
not silent.

For social videos, state the route in the final answer: `local reuse`, `public yt-dlp`,
`browser-assisted`, `local-file handoff`, or `API-enhanced`. Browser assistance is orchestrated by
the host agent, not by the MCP server, and may not exist in every Claude/Codex client.

## Manual-tools rule

If you must reach for raw yt-dlp / ffmpeg directly, **import the result back into VidLens** so
it becomes durable memory: pass the downloaded local file path to `importVideoSources` (it
accepts local video files) — optionally with `transcribe: true` and/or `indexVisualContent:
true`. Don't leave extracted material stranded outside the library where the next session can't
find it.

## Known limitations

- **Gemini STT timestamps are chunk-granular** — when transcribing via Gemini, segment
  timestamps are quantized to the chunk boundary, not word-accurate. Native YouTube captions
  keep fine-grained timing.
- **Visual OCR is macOS-only** — Apple Vision OCR and feature prints require macOS. On
  Linux/Windows, visual indexing falls back to Gemini frame descriptions/embeddings (requires
  `GEMINI_API_KEY`); OCR text is unavailable.
- Comment coverage without `YOUTUBE_API_KEY` is best-effort and may be incomplete.
