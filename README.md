<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/brand/readme-banner-web.png?v=20260820" alt="VidLens — your AI can read the web, now it can also watch it" width="800" />
</p>

**Your AI can read the web.**\
**Now it can also watch it.**

```bash
npx vidlens-mcp setup
```

- **Research video:** search, transcribe, compare, and cite YouTube and public social video.
- **Build a local library:** import once, then search transcripts, comments, frames, and OCR without fetching the same video again.
- **Inspect visual evidence:** find the exact frame, timestamp, match reason, and source in a visual gallery plus structured client output.

VidLens is an [MCP](https://modelcontextprotocol.io/) server that gives your AI agent eyes on video — YouTube, X, TikTok, Instagram, other video pages, or a file on your disk. Paste a link and ask a question. VidLens reads the transcript, looks at the frames, and answers with timestamps you can check. Everything it ingests lands in a library on your own machine, so your agent never has to watch the same video twice.

No API keys to start. Works in Claude Desktop, Claude Code, and Codex. Capable clients can turn VidLens's structured results into native charts, cards, tables, and visual reports in their own response surfaces.

---

## Try it

Once VidLens is set up, paste any of these into your AI client:

> "Search YouTube for M5 Max MacBook Pro reviews. What do reviewers agree on, and where do they disagree?"

VidLens searches, reads the transcripts across reviewers, and synthesizes consensus and disagreement with sources and timestamps.

> "Transcribe this video and summarize it: https://x.com/username/status/123..."

A single public X, Instagram, or TikTok video URL usually needs no API key at all. VidLens fetches it, transcribes it, and keeps the transcript so you can ask follow-up questions later — in this session or any future one.

> "Find the frame in this video where they show the benchmark chart."

Visual search looks at what is on screen — slides, charts, whiteboards, product shots — and shows the actual frame image with its timestamp in the local browser gallery, not just a text guess.

### Native client presentation

VidLens returns portable structured evidence: sources, timestamps, scores, OCR, descriptions, provenance, and limitations. Codex, Claude, and other capable clients can compose that evidence into their own native charts, comparison cards, tables, and visual reports. This presentation belongs to the client rather than an embedded VidLens UI. For extracted frame inspection, `searchVisualContent` can also open the existing external browser gallery.

---

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/arch/arch-system-overview-v2-web.png?v=20260820" alt="Sources flow through ingestion into the VidLens MCP server, into a local library that your agents query" width="800" />
</p>

Video sources go in on the left. VidLens ingests them through whichever route works — the YouTube API when a key is configured, yt-dlp, or direct page extraction — and stores the results in a local library: transcripts, frames, and embeddings. Your agents query that library from any MCP client.

Two honesty guarantees are built in:

- **Fallbacks, not failures.** Every YouTube data tool tries multiple routes before giving up, so a missing key or an exhausted quota degrades gracefully instead of breaking.
- **Provenance on responses.** Tool responses report which route served the data and whether anything was partial. No silent degradation.

Everything lives in one directory on your disk. No external database, no Docker. Back it up by copying it; delete it to start fresh.

---

## Install

### Setup wizard (recommended)

```bash
npx vidlens-mcp setup
```

The wizard detects supported MCP clients (Claude Desktop, Claude Code, and Codex), installs the free local dependencies it needs, and explains which optional upgrades apply to your use case. Normal setup does not ask for API keys, speech-to-text providers, web search, or cookies; use `--advanced` when you want those. For Claude Code, setup registers VidLens in the user MCP registry and checks the result with `claude mcp list` when possible.

### Manual configuration

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vidlens-mcp": {
      "command": "npx",
      "args": ["-y", "vidlens-mcp", "serve"]
    }
  }
}
```

**Claude Code** — prefer the wizard:

```bash
npx vidlens-mcp setup --client claude_code
claude mcp list
```

If you configure it by hand instead, add the same `mcpServers.vidlens-mcp` entry to `~/.claude.json`.

**Codex** — use the setup helper so the MCP server and bundled VidLens skills are registered together:

```bash
npx vidlens-mcp setup --client codex
```

### Restart your client

Fully quit and reopen Claude Desktop (⌘Q, not just close the window) — MCP servers load on startup. For Claude Code, start a new session or run `/mcp` after setup.

### From a local checkout

`npm install` in a checkout does not put the binary on your `PATH`. Use `npm run setup` from the checkout, or `npm install -g .` / `npm link` if you want the bare `vidlens-mcp` command while developing.

---

## Your library

VidLens is durable memory for video work, not a per-session scratchpad. Everything you import persists on disk under `VIDLENS_DATA_DIR`: transcript collections, comment collections, downloaded media, and visual indexes. Even the active collection is remembered.

**Recall it in one call.** At the start of a session, `recallWorkspace` returns a compact digest of everything already stored, so an agent knows what it has before searching or importing again. Tool descriptions carry the same reminder into every client, so agents check first instead of re-fetching.

**Reuse by URL or asset key.** An imported social video's transcript can be pulled up again by its original URL or by its asset key — no re-download, no re-transcription.

**One shared library across agents.** The default data directory is the same for every client, so Claude Desktop, Claude Code, and Codex all share one library — import a video in one, search it from another.

> ⚠️ **Do not put `VIDLENS_DATA_DIR` inside Dropbox, iCloud, Google Drive, or any file-sync folder.** VidLens uses SQLite (with WAL), and live databases under a file syncer get corrupted or spawn conflict copies. Keep the data dir on a local disk — the default location already does.

---

## Beyond YouTube

For X, Instagram, TikTok, and generic video pages, VidLens uses a capability ladder: it takes the cheapest route that works, and an API key is an uplift, not a prerequisite.

| Route | Cost | Best for | What happens |
|---|---|---|---|
| Local reuse | Free | Anything imported before | `recallWorkspace` finds the stored transcript or media; nothing is re-fetched |
| Public direct URL | Free | One X status, Instagram reel/post, or TikTok video | yt-dlp tries the canonical post URL anonymously; ffmpeg and local or configured STT handle media with no captions |
| Browser-assisted | Free with a supported host | Finding or verifying a post, or using an existing signed-in session | Your client's browser control captures the canonical URL and visible metadata, then hands the URL back to VidLens |
| Local-file handoff | Free | A video you are permitted to save | Import the saved file for transcription and visual indexing |
| API-enhanced | Provider pricing | Bulk, unattended, or repeatable discovery | Configured ScrapeCreators, Brave, SerpAPI, YouTube, Gemini, or OpenAI capabilities are selected automatically |

Three caveats, stated plainly:

- **Browser assistance is host-level.** The MCP server does not control a browser itself; it relies on whatever browser tooling your client provides, which differs by host.
- **Seeing a video is not the same as exporting it.** A post that plays in a browser does not guarantee automatic media export.
- **Concrete URLs only.** VidLens imports specific post or video URLs, never profiles, explore pages, hashtags, or popularity pages.

For social and local video work beyond plain download, install ffmpeg (`brew install ffmpeg` on macOS) — frame extraction, visual indexing, and STT audio chunking need it.

---

## The tools — 47 across 11 modules

### Explore — YouTube discovery and research (1)

| Tool | What it does |
|---|---|
| `exploreYouTube` | Intent-aware search with multi-query ranking, transcript summaries, structured benchmark data, and background indexing. One call replaces 5–8 individual tool calls. |

### Core — video and channel intelligence (7)

| Tool | What it does |
|---|---|
| `findVideos` | Search YouTube by query with metadata |
| `inspectVideo` | Deep metadata — tags, engagement, language, category |
| `inspectChannel` | Channel stats, description, recent uploads |
| `listChannelCatalog` | Browse a channel's full video library |
| `readTranscript` | Full transcript with timestamps and chapters |
| `readComments` | Top comments with likes and engagement |
| `expandPlaylist` | List all videos in any playlist |

### Knowledge base — semantic transcript search (7)

| Tool | What it does |
|---|---|
| `importPlaylist` | Index an entire playlist's transcripts |
| `importVideos` | Index specific videos by URL or ID |
| `searchTranscripts` | Natural-language search across indexed content |
| `listCollections` | Browse your indexed collections |
| `setActiveCollection` | Scope searches to one collection |
| `clearActiveCollection` | Search across all collections |
| `removeCollection` | Delete a collection and its index |

### Sentiment and analysis (4)

| Tool | What it does |
|---|---|
| `measureAudienceSentiment` | Comment sentiment with themes and risk signals |
| `analyzeVideoSet` | Compare performance across multiple videos |
| `analyzePlaylist` | Playlist-level engagement analytics |
| `buildVideoDossier` | Complete single-video deep analysis |

### Creator intelligence (4)

| Tool | What it does |
|---|---|
| `scoreHookPatterns` | Analyze what makes video openings work |
| `researchTagsAndTitles` | Tag and title optimization insights |
| `compareShortsVsLong` | Short-form vs long-form performance |
| `recommendUploadWindows` | Best times to publish for engagement |

### Discovery and trends (2)

| Tool | What it does |
|---|---|
| `discoverNicheTrends` | Momentum, saturation, and content gaps in any topic |
| `exploreNicheCompetitors` | Channel landscape and top performers |

### Universal video sources (5)

| Tool | What it does |
|---|---|
| `inspectVideoSource` | Resolve YouTube, X, Instagram, TikTok, generic URLs, and local files into source metadata and capability flags |
| `searchVideoSources` | Search native YouTube and local assets, with ScrapeCreators support for TikTok/Instagram plus configurable Brave/SerpAPI/DuckDuckGo fallback |
| `searchSocialTrends` | Search social platforms through ScrapeCreators; returns a ranked list with engagement metrics and importable URLs where available |
| `importVideoSources` | Import URLs or local files into the local media store, optionally building a visual index or transcript |
| `transcribeVideoSource` | Transcribe YouTube, social/generic URLs, and local files via native captions or configured STT |

### Media assets (5)

| Tool | What it does |
|---|---|
| `downloadAsset` | Download or ingest video, audio, or thumbnails from any supported source |
| `listMediaAssets` | Browse stored media files |
| `removeMediaAsset` | Clean up downloaded assets |
| `extractKeyframes` | Extract key frames from videos |
| `mediaStoreHealth` | Storage usage and diagnostics |

### Visual search and evidence (3)

| Tool | What it does |
|---|---|
| `indexVisualContent` | Extract frames; run Apple Vision OCR and feature prints, Gemini frame descriptions, and Gemini semantic embeddings |
| `searchVisualContent` | Search frames by meaning and text; returns timestamped evidence and can open the external browser gallery |
| `findSimilarFrames` | Image-to-image frame similarity using Apple Vision feature prints |

Visual search is a dedicated index, separate from transcripts. Every match includes its timestamp, source video, OCR text, and visual description. Local frame paths and `file:` URLs are removed from MCP results; the browser gallery reads the images locally without exposing those paths to the client.

### Comment knowledge base (6)

| Tool | What it does |
|---|---|
| `importComments` | Index a video's comments for search |
| `searchComments` | Natural-language search over the comment corpus |
| `listCommentCollections` | Browse comment collections |
| `setActiveCommentCollection` | Scope comment searches |
| `clearActiveCommentCollection` | Search all comment collections |
| `removeCommentCollection` | Delete a comment collection |

### Diagnostics (3)

| Tool | What it does |
|---|---|
| `recallWorkspace` | Session-start digest of everything already imported — call first to avoid re-importing |
| `checkSystemHealth` | Full system diagnostic report |
| `checkImportReadiness` | Validate before importing content |

---

## Optional API keys

VidLens works without any keys. Add them for scale and reliability:

| Key | What it unlocks | Free? | Where |
|---|---|---|---|
| `YOUTUBE_API_KEY` | Better metadata, comment API, YouTube API search | Google quota applies | [Google Cloud Console](https://console.cloud.google.com/) → enable YouTube Data API v3 → create API key |
| `GEMINI_API_KEY` | Higher-quality embeddings for semantic and visual search, frame descriptions | Provider pricing and limits apply | [Google AI Studio](https://aistudio.google.com/) |
| `OPENAI_API_KEY` | Optional STT provider for transcription | Paid | [OpenAI Platform](https://platform.openai.com/) |
| `SCRAPECREATORS_API_KEY` | Direct social search and trending for TikTok, Instagram, Threads, Pinterest, Reddit, and supported endpoints | Provider pricing applies | [ScrapeCreators](https://app.scrapecreators.com/) |
| `BRAVE_API_KEY` / `SERPAPI_KEY` | Structured web search for social and generic URL discovery | Varies | Brave Search API or SerpAPI |

> ⚠️ **The YouTube and Gemini keys are separate keys from separate Google services.** A Gemini key will not work for YouTube API calls, and vice versa.

```bash
# Free-core setup asks for no keys.
npx vidlens-mcp setup

# Advanced setup optionally prompts for keys, STT, web search, and cookies.
npx vidlens-mcp setup --advanced

# Or pass everything non-interactively.
npx vidlens-mcp setup \
  --youtube-api-key YOUR_YOUTUBE_KEY \
  --gemini-api-key YOUR_GEMINI_KEY \
  --stt-provider auto \
  --cookies-from-browser chrome
```

### Cookies and speech-to-text

For platforms that rate-limit anonymous access, the wizard can persist cookies by browser profile or file path:

```bash
npx vidlens-mcp setup --cookies-from-browser chrome --cookies-profile Default
npx vidlens-mcp setup --x-cookies-file /path/to/x-cookies.txt
```

Or via environment variables: `VIDLENS_COOKIES_FROM_BROWSER`, `VIDLENS_X_COOKIES_FILE`, `VIDLENS_INSTAGRAM_COOKIES_FILE`, `VIDLENS_TIKTOK_COOKIES_FILE`.

STT selection is automatic: local whisper.cpp first, then Gemini, then OpenAI. Override with `VIDLENS_STT_PROVIDER=whisper-cpp|gemini|openai|none|auto`. When the wizard asks, pressing Enter for `auto` is the right answer for most people.

---

## CLI

```bash
npx vidlens-mcp               # Start MCP server (stdio)
npx vidlens-mcp serve         # Start MCP server (explicit)
npx vidlens-mcp setup         # Configure clients, keys, STT, cookies
npx vidlens-mcp doctor        # Run diagnostics
npx vidlens-mcp doctor --no-live   # Diagnostics without network checks
npx vidlens-mcp update-deps   # Refresh managed yt-dlp and Deno helpers
npx vidlens-mcp version       # Print version
```

`doctor` checks Node.js version, yt-dlp freshness, STT and web-search providers, API key validity, data directory health, and MCP client registration for Claude Desktop, Claude Code, and Codex.

---

## Requirements

| Requirement | Status | Notes |
|---|---|---|
| **Node.js ≥ 22** | Required | Uses `node:sqlite` — check with `node --version` |
| **yt-dlp** | Auto-installed | Downloaded during `npx vidlens-mcp setup` |
| **ffmpeg + ffprobe** | Recommended | Needed for media validation, frame extraction, visual indexing, and STT audio processing |
| **YouTube API key** | Optional | Better metadata and comment access |
| **Gemini API key** | Optional | Better embeddings and frame descriptions |
| **macOS** | Optional | Apple Vision powers native OCR and image similarity; other platforms can use Gemini descriptions when configured |

---

## Security and privacy

- Your library — transcripts, frames, embeddings, media — is stored locally and stays on your machine. Network calls go only to the sources you query and the APIs you configure.
- Setup stores configured keys in your local MCP client configuration. Prefer the interactive advanced setup; keys supplied as CLI flags may remain in shell history. Error messages pass through a secret redactor so keys and cookie paths are not echoed in tool output.
- Fetches of channel pages and generic URLs reject private, link-local, and loopback addresses (SSRF guard). Escape hatch for intentional local use: `VIDLENS_ALLOW_PRIVATE_URLS=1`.

---

## Troubleshooting

**"Tool not found" in Claude Desktop.** Fully quit (⌘Q) and reopen. MCP servers load only on startup.

**"YOUTUBE_API_KEY not configured" warning.** Informational, not an error. VidLens works without it.

**"API_KEY_SERVICE_BLOCKED".** The key is not allowed to call the requested Google service. In Google Cloud Console, enable the YouTube Data API v3 and allow that API in the key's API restrictions. Keep appropriate application restrictions for where you run VidLens; do not make the key unrestricted unless you are only doing a short diagnostic and will restrict it again immediately.

**Gemini key doesn't work for YouTube.** They are separate services with separate keys. See [Optional API keys](#optional-api-keys).

**Social video downloads but visual analysis fails.** Install ffmpeg, then re-run setup:

```bash
brew install ffmpeg
```

```bash
npx vidlens-mcp doctor --no-live
```

`downloadAsset` can often fetch a video without ffmpeg, but `indexVisualContent`, `extractKeyframes`, media validation, and STT audio processing need ffmpeg or ffprobe.

**Anything else:**

```bash
npx vidlens-mcp doctor
```

---

## License

MIT

[GitHub](https://github.com/thatsrajan/vidlens-mcp) · [npm](https://www.npmjs.com/package/vidlens-mcp) · [Model Context Protocol](https://modelcontextprotocol.io/)
