---
name: vidlens-workflows
description: Multi-tool workflows and check-first protocol for VidLens. Use when importing, transcribing, or visually indexing videos, or whenever you might re-fetch video material — VidLens imports persist across sessions and should be reused, not re-imported.
---

# VidLens workflows

VidLens stores everything on disk under `VIDLENS_DATA_DIR` (SQLite + media files) and
that data **survives across sessions and clients**. Claude Desktop, Claude Code, and
Codex all talk to the same MCP server pointed at the same default data dir, so one
agent's imports are visible to the others. The whole point of VidLens over raw yt-dlp
is that imports persist and become searchable.

## Check-first protocol (do this before any import or download)

1. **`recallWorkspace`** — call this first in a new session. It returns a compact digest
   of every transcript collection, comment collection, media asset, and visual index
   already stored, plus a hint. If what you need is already there, skip straight to search.
2. **`listCollections` / `listCommentCollections` / `listMediaAssets`** — for more detail
   on a specific collection or asset.
3. **Search before importing** — `searchTranscripts`, `searchComments`, `searchVisualContent`
   query existing collections instantly. Only import when the material genuinely isn't there.

Re-importing what you already have wastes time and burns API quota. Assume nothing was
lost between sessions.

## readTranscript vs importVideos — cheap one-off vs durable library

- **`readTranscript`** — a cheap, one-shot fetch of a single video's transcript. Use it when
  you just need to read/quote a transcript once and don't need it searchable later.
- **`importVideos` / `importPlaylist`** — durable ingest: chunks the transcript, builds an
  embedding index, and makes it semantically searchable across sessions via
  `searchTranscripts`. Use this when the goal is a lasting, queryable video memory, or when
  you'll search across many videos.
- **`importComments`** does the same for comments (searchable via `searchComments`).
- **`indexVisualContent`** builds a persistent visual index (frames + OCR + optional Gemini
  descriptions/embeddings), queryable via `searchVisualContent`.
- **`searchVisualContent`** only queries an existing visual index; call `indexVisualContent` first
  when needed. It returns structured evidence that capable clients can present through their own
  native response surfaces and can open a local browser gallery for frame inspection.

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
- **`YOUTUBE_API_KEY`:** higher-fidelity search, richer metadata, reliable comment fetching
  and pagination. Without it, comments fall back to scraping (may return fewer or none).
- **`GEMINI_API_KEY`:** Gemini embeddings for transcript/visual semantic search and Gemini
  frame descriptions (needed for visual descriptions on non-macOS). Without it, transcript
  embeddings are local (LSA) and visual indexing relies on Apple Vision OCR.
- **`OPENAI_API_KEY`:** OpenAI speech-to-text for sources without native captions.
- **`SCRAPECREATORS_API_KEY`:** paid reliability/scale for social discovery. Prefer it when it is
  configured, but do not make it a requirement for a user handling an individual video.

Provenance in every tool result reports which tier answered, so degraded answers are visible,
not silent.

For social videos, state the route in the final answer: `local reuse`, `public yt-dlp`,
`browser-assisted`, `local-file handoff`, or `API-enhanced`.

## Manual-tools rule

If you must reach for raw yt-dlp / ffmpeg directly (e.g. an edge case VidLens can't resolve),
**import the result back into VidLens** so it becomes durable memory: pass the downloaded
local file path to `importVideoSources` (it accepts local video files) — optionally with
`transcribe: true` and/or `indexVisualContent: true`. Don't leave extracted material stranded
outside the library where the next session can't find it.

## Known limitations

- **Gemini STT timestamps are chunk-granular** — when transcribing via Gemini, segment
  timestamps are quantized to the chunk boundary, not word-accurate. Native YouTube captions
  keep fine-grained timing.
- **Visual OCR is macOS-only** — Apple Vision OCR and feature prints require macOS. On
  Linux/Windows, visual indexing falls back to Gemini frame descriptions/embeddings (requires
  `GEMINI_API_KEY`); OCR text is unavailable.
- Comment coverage without `YOUTUBE_API_KEY` is best-effort and may be incomplete.
