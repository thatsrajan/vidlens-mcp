<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/readme-banner.png?v=20260407" alt="VidLens — video as a queryable local asset for AI agents" width="800" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vidlens-mcp"><img src="https://img.shields.io/npm/v/vidlens-mcp?style=flat-square&color=red" alt="npm" /></a>
  <a href="https://github.com/thatsrajan/vidlens-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-green?style=flat-square" alt="MCP" /></a>
  <img src="https://img.shields.io/badge/tools-45-orange?style=flat-square" alt="45 tools" />
  <img src="https://img.shields.io/badge/zero--config-✓-brightgreen?style=flat-square" alt="Zero Config" />
</p>

<p align="center">
  <a href="https://youtu.be/0BqrMKWIXkg">
    <img src="https://img.shields.io/badge/▶%20Watch%20the%2060s%20demo-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the 60s demo" />
  </a>
</p>

<p align="center">
  <em>Most tools can read what was said in a video. VidLens can see what was shown.</em>
</p>

---

## 🔍 What is VidLens?

**Stop watching 10 videos to answer one question.** VidLens searches YouTube, reads the transcripts, and synthesizes what creators actually said — across multiple videos, with timestamps, benchmark charts, and sources.

VidLens is a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI agents deep, reliable access to YouTube. Not just transcripts — full intelligence: search, analysis, visual search, and auto-generated comparison charts.

It is also growing into a universal video asset layer: direct video URLs from X/Twitter, Instagram, TikTok, generic yt-dlp-supported pages, and local video files can be imported into the same local media store for frame extraction, Apple Vision OCR/similarity, and visual search. Claude Desktop, Claude Code, Codex CLI, and the Codex desktop plugin all use the same MCP server.

**No API key required to start.** Every tool has a three-tier fallback chain (YouTube API → yt-dlp → page extraction) so nothing breaks when quota runs out or keys aren't configured.

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/gifs/demo-one-prompt-research.gif" alt="One prompt → full research pipeline with benchmark comparison" width="800" />
</p>

### Try it — paste any of these into Claude:

> **"I'm thinking about buying the M5 Max MacBook Pro.**
> **Search YouTube for top tech reviewers and tell me what they're saying. Is it worth the upgrade from M3/M4?"**
>
> *VidLens finds 10+ reviews, reads the transcripts, extracts benchmark scores, and presents comparison charts — all from one prompt.*

> **"I want to understand how AI agents work.**
> **Search YouTube for the best videos for a beginner and summarize what I need to know."**
>
> *Discovers videos across creators, ranks by learning value, and prepares transcripts for follow-up questions.*

> **"Search YouTube for reviews comparing the iPhone 17 Pro vs Samsung S26 Ultra.**
> **What do reviewers agree on? Where do they disagree?"**
>
> *Searches, reads transcripts from multiple reviewers, and synthesizes consensus vs disagreements with sources.*

---

## 🎯 Core Capabilities

### 🔍 Explore — One Prompt, Full Pipeline
Ask a question about YouTube and VidLens does the rest: searches, ranks by creator match and freshness, reads transcripts, extracts benchmark data, and presents comparison charts automatically. Works for product research, learning, competitive analysis — anything on YouTube.

### 🔎 Semantic Search Across Playlists
Import entire playlists or video sets, index every transcript with Gemini embeddings, and search across hundreds of hours of content by meaning — not just keywords.

### 👁️ Visual Search — See What's In Videos
Extract keyframes, describe them with Gemini Vision, run OCR on slides and whiteboards, and search by what you **see** — not just what's said.

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/gifs/demo-visual-search.gif" alt="Visual search — find benchmark charts inside videos by searching" width="800" />
</p>

### 📊 Intelligence Layer — Not Just Data
Sentiment analysis, niche trend discovery, content gap detection, hook pattern analysis, upload timing recommendations. The LLM does the thinking — VidLens gives it the right data.

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/gifs/demo-video-intelligence.gif" alt="Video intelligence — stats, structure analysis, and comment sentiment" width="800" />
</p>

### ⚡ Zero Config, Always Works
No API key needed to start. Three-tier fallback chain on every tool. Nothing breaks when quota runs out. Keys are optional power-ups.

### 🎬 Full Media Pipeline
Download videos/audio/thumbnails. Extract keyframes. Index comments for semantic search. Build a local knowledge base from any YouTube content.

---

## ⚡ Why VidLens?

<table>
<tr><th></th><th>VidLens</th><th>Other YouTube MCP servers</th></tr>
<tr><td>🔑 <strong>Setup</strong></td><td>✅ Works immediately - no keys needed</td><td>❌ Most require YouTube API key upfront</td></tr>
<tr><td>🛡️ <strong>Reliability</strong></td><td>✅ Three-tier fallback on every tool</td><td>❌ Single point of failure - API down = broken</td></tr>
<tr><td>🧠 <strong>Intelligence</strong></td><td>✅ Sentiment, trends, content gaps, hooks</td><td>❌ Raw data dumps - you do the analysis</td></tr>
<tr><td>📦 <strong>Token efficiency</strong></td><td>✅ 75-87% smaller responses</td><td>❌ Verbose JSON with thumbnails, etags, junk</td></tr>
<tr><td>🔬 <strong>Depth</strong></td><td>✅ 45 tools across 11 modules</td><td>⚠️ 1-5 tools, mostly transcripts only</td></tr>
<tr><td>🖼️ <strong>Visual evidence</strong></td><td>✅ Returns actual frame paths + timestamps, not just text hits</td><td>⚠️ Usually transcript-only or raw frame dumps</td></tr>
<tr><td>⚖️ <strong>Trademark</strong></td><td>✅ Compliant naming</td><td>⚠️ Most violate YouTube trademark</td></tr>
</table>

---

## 🚀 Quick Start

### 1. Install

```bash
npx vidlens-mcp setup
```

This auto-detects your MCP clients (Claude Desktop, Claude Code, Codex when present), downloads **yt-dlp** if needed, and walks you through optional API keys, speech-to-text, web search, and cookies. No manual config editing required. For Claude Code, setup registers VidLens in the user MCP registry and verifies the result with `claude mcp list`; when API keys or cookie settings are present, it writes the registry file directly so secrets are not passed through command arguments.

If you install globally with `npm install -g vidlens-mcp`, npm prints the next command to run. The install step itself does not collect secrets; `vidlens-mcp setup` is the interactive configuration wizard that writes the MCP env blocks for your clients.

From a local checkout, `npm install` does not put this package's own binary on your shell `PATH`. Use `npm run setup` from the checkout, or run `npm install -g .` / `npm link` if you want the bare `vidlens-mcp` command while developing.

### 2. Or configure manually

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

**Claude Code** — prefer the setup wizard. It registers VidLens in Claude Code's user MCP registry and checks that Claude Code can see it:

```bash
npx vidlens-mcp setup --client claude_code
claude mcp list
```

If you must configure it manually, add the same `mcpServers.vidlens-mcp` entry to the Claude Code user registry file at `~/.claude.json`.

### 3. Restart your MCP client

Fully quit and reopen Claude Desktop (⌘Q). For Claude Code, start a new session or run `/mcp` again after setup.

### 4. Try it

Start with "Search YouTube" to activate VidLens:

> "Search YouTube for the top M5 Max MacBook Pro reviews and tell me if it's worth upgrading from M4."
>
> "Search YouTube for the best videos about agentic AI for a beginner."
>
> "Import this playlist and search across all videos for mentions of machine learning."
>
> "Search this video's frames for the benchmark comparison chart."
>
> "What's trending in the AI coding niche right now?"

---

## 🧰 Tools - 44 across 11 modules

### 🔍 Explore - YouTube Discovery & Research
*The front door — one prompt, full pipeline*

| Tool | What it does |
|---|---|
| `exploreYouTube` | Intent-aware search with multi-query ranking, parallel enrichment, transcript summaries, structured benchmark data, and background indexing. One call replaces 5-8 individual tool calls. |

### 📺 Core - Video & Channel Intelligence
*Always available, no API key needed*

| Tool | What it does |
|---|---|
| `findVideos` | Search YouTube by query with metadata |
| `inspectVideo` | Deep metadata - tags, engagement, language, category |
| `inspectChannel` | Channel stats, description, recent uploads |
| `listChannelCatalog` | Browse a channel's full video library |
| `readTranscript` | Full transcript with timestamps and chapters |
| `readComments` | Top comments with likes and engagement |
| `expandPlaylist` | List all videos in any playlist |

### 🔎 Knowledge Base - Semantic Search
*Index transcripts and search across them with natural language*

| Tool | What it does |
|---|---|
| `importPlaylist` | Index an entire playlist's transcripts |
| `importVideos` | Index specific videos by URL/ID |
| `searchTranscripts` | Natural language search across indexed content |
| `listCollections` | Browse your indexed collections |
| `setActiveCollection` | Scope searches to one collection |
| `clearActiveCollection` | Search across all collections |
| `removeCollection` | Delete a collection and its index |

### 💬 Sentiment & Analysis
*Understand what audiences think and feel*

| Tool | What it does |
|---|---|
| `measureAudienceSentiment` | Comment sentiment with themes and risk signals |
| `analyzeVideoSet` | Compare performance across multiple videos |
| `analyzePlaylist` | Playlist-level engagement analytics |
| `buildVideoDossier` | Complete single-video deep analysis |

### 🎯 Creator Intelligence
*Insights for content strategy*

| Tool | What it does |
|---|---|
| `scoreHookPatterns` | Analyze what makes video openings work |
| `researchTagsAndTitles` | Tag and title optimization insights |
| `compareShortsVsLong` | Short-form vs long-form performance |
| `recommendUploadWindows` | Best times to publish for engagement |

### 📈 Discovery & Trends
*Find what's working in any niche*

| Tool | What it does |
|---|---|
| `discoverNicheTrends` | Momentum, saturation, content gaps in any topic |
| `exploreNicheCompetitors` | Channel landscape and top performers |

### 🌐 Universal Video Sources
*Resolve, search, and import video sources beyond YouTube*

| Tool | What it does |
|---|---|
| `inspectVideoSource` | Resolve YouTube, X/Twitter, Instagram, TikTok, generic URLs, and local files into source metadata and capability flags |
| `searchVideoSources` | Search native YouTube and local assets, with configurable Brave/SerpAPI/DuckDuckGo fallback for social/web video discovery |
| `importVideoSources` | Import URLs or local files into the local media store, optionally building a visual index or transcript |
| `transcribeVideoSource` | Transcribe YouTube, social/generic URLs, and local files into the transcript knowledge base via native captions or configured STT |

### 🎬 Media Assets
*Download and manage video files locally*

| Tool | What it does |
|---|---|
| `downloadAsset` | Download or ingest video, audio, or thumbnails from YouTube/social URLs/generic URLs/local files |
| `listMediaAssets` | Browse stored media files |
| `removeMediaAsset` | Clean up downloaded assets |
| `extractKeyframes` | Extract key frames from videos |
| `mediaStoreHealth` | Storage usage and diagnostics |

### 🖼️ Visual Search
*Three-layer visual intelligence. Not transcript reuse.*

| Tool | What it does |
|---|---|
| `indexVisualContent` | Extract frames, run Apple Vision OCR + feature prints, Gemini frame descriptions, and Gemini semantic embeddings |
| `searchVisualContent` | Search visual frames using semantic embeddings + lexical matching. Returns actual image paths + timestamps as evidence |
| `findSimilarFrames` | Image-to-image frame similarity using Apple Vision feature prints |

**Three layers, all real:**
1. **Apple Vision feature prints** — image-to-image similarity (find frames that look alike)
2. **Gemini 2.5 Flash frame descriptions** — natural language scene understanding per frame
3. **Gemini semantic embeddings** — 768-dim embedding retrieval over OCR + description text for true text→visual search

**What you always get back:** frame path on disk, timestamp, source video URL/title, match explanation, OCR text, visual description.

**What is NOT happening:** no transcript embeddings are reused for visual search. This is a separate visual index.

### 💭 Comment Knowledge Base
*Index and semantically search YouTube comments*

| Tool | What it does |
|---|---|
| `importComments` | Index a video's comments for search |
| `searchComments` | Natural language search over comment corpus |
| `listCommentCollections` | Browse comment collections |
| `setActiveCommentCollection` | Scope comment searches |
| `clearActiveCommentCollection` | Search all comment collections |
| `removeCommentCollection` | Delete a comment collection |

### 🏥 Diagnostics
*Health checks and pre-flight validation*

| Tool | What it does |
|---|---|
| `checkSystemHealth` | Full system diagnostic report |
| `checkImportReadiness` | Validate before importing content |

---

## 🔑 API Keys (Optional)

VidLens works **without any API keys**. Add them to unlock more capabilities:

| Key | What it unlocks | Free? | How to get it |
|---|---|---|---|
| `YOUTUBE_API_KEY` | Better metadata, comment API, search via YouTube API | ✅ Free tier (10,000 units/day) | [Google Cloud Console](https://console.cloud.google.com/) → APIs → Enable YouTube Data API v3 → Credentials → Create API Key |
| `GEMINI_API_KEY` | Higher-quality embeddings for semantic search (768d vs 384d) | ✅ Free tier | [Google AI Studio](https://aistudio.google.com/) → Get API Key |
| `OPENAI_API_KEY` | Optional STT provider for `transcribeVideoSource` | Paid/free trial varies | [OpenAI Platform](https://platform.openai.com/) |
| `BRAVE_API_KEY` / `SERPAPI_KEY` | Optional structured web search for social/generic URL discovery | Varies | Brave Search API or SerpAPI |

> ⚠️ **These are separate keys from separate Google services.** A Gemini key will NOT work for YouTube API calls and vice versa. Create them independently.

```bash
# Configure via setup wizard. It prompts for YouTube, Gemini, OpenAI,
# Brave/SerpAPI, STT, browser cookies, and platform cookies.
npx vidlens-mcp setup

# Or provide everything non-interactively.
npx vidlens-mcp setup \
  --youtube-api-key YOUR_YOUTUBE_KEY \
  --gemini-api-key YOUR_GEMINI_KEY \
  --openai-api-key YOUR_OPENAI_KEY \
  --brave-api-key YOUR_BRAVE_KEY \
  --stt-provider auto \
  --cookies-from-browser chrome

# Or via environment variables
export YOUTUBE_API_KEY=your_youtube_key
export GEMINI_API_KEY=your_gemini_key
export OPENAI_API_KEY=your_openai_key
export BRAVE_API_KEY=your_brave_key
```

### Cookies, STT, and Codex

For platforms that rate-limit anonymous access, the setup wizard can persist cookies by browser profile or file path into Claude/Codex config:

```bash
npx vidlens-mcp setup --cookies-from-browser chrome --cookies-profile Default
npx vidlens-mcp setup --x-cookies-file /path/to/x-cookies.txt
```

Recommended wizard answers for most users:

| Prompt | Recommended answer | Why |
|---|---|---|
| STT provider | Press Enter for `auto` | Setup checks local whisper.cpp, then Gemini, then OpenAI after you answer |
| Default STT language hint | `en` if most videos are English; otherwise press Enter | Helps STT quality without locking you in |
| whisper.cpp model path | Press Enter unless you already have a local model file | Gemini/OpenAI fallback is simpler |
| Web search provider | Press Enter for `auto` | Setup checks Brave/SerpAPI keys, then DuckDuckGo-lite |
| Use browser cookies | Your logged-in browser, e.g. `chrome` | Lets yt-dlp read social-video cookies during import |
| Browser profile name | Press Enter unless you use a named profile | Most users do not need this |
| Platform-specific cookie files | `n` unless you exported Netscape cookie files | Browser cookies are easier |

You can also configure them directly in your shell:

```bash
export VIDLENS_X_COOKIES_FILE=/path/to/x-cookies.txt
export VIDLENS_INSTAGRAM_COOKIES_FILE=/path/to/instagram-cookies.txt
export VIDLENS_TIKTOK_COOKIES_FILE=/path/to/tiktok-cookies.txt
export VIDLENS_COOKIES_FROM_BROWSER=chrome
```

STT selection is automatic: local `whisper.cpp` first, then Gemini, then OpenAI. Override with `VIDLENS_STT_PROVIDER=whisper-cpp|gemini|openai|none|auto`.

Codex setup:

```bash
vidlens-mcp setup --client codex --print-only
vidlens-mcp doctor --no-live
vidlens-mcp update-deps
```

---

## 💻 CLI

```bash
npx vidlens-mcp               # Start MCP server (stdio)
npx vidlens-mcp serve         # Start MCP server (explicit)
npx vidlens-mcp setup         # Auto-configure Claude Desktop, Claude Code, Codex, keys, STT, and cookies
npx vidlens-mcp doctor        # Run diagnostics
npx vidlens-mcp update-deps   # Refresh managed yt-dlp and Deno helpers
npx vidlens-mcp version       # Print version
npx vidlens-mcp help          # Usage guide
```

### Doctor - diagnose issues

```bash
npx vidlens-mcp doctor --no-live
```

Checks: Node.js version, yt-dlp freshness, JS runtime, STT and web-search providers, platform readiness, API key validation, data directory health, MCP client registration (Claude Desktop, Claude Code, Codex), and whether `claude mcp list` can see the Claude Code registration.

---

## 📱 Works Everywhere — Desktop, Cowork, Phone

VidLens works across the full Claude ecosystem. Set it up once, use it everywhere.

### Claude Desktop — Chat
The classic experience. Ask a question, get charts and analysis inline. Best for interactive research sessions.

### Claude Desktop — Cowork Projects *(March 2026)*
Create a persistent research project with VidLens connected. Claude remembers context across sessions — last week's competitive research informs this week's analysis. Set up scheduled tasks that run automatically:

> *"Every Monday, search YouTube for new AI agent framework videos and compare to last week's findings."*

### Claude Dispatch — From Your Phone *(March 2026)*
Trigger any VidLens research from the Claude mobile app. Ask from your phone, Claude Desktop runs the tools locally, results come back to your pocket:

> *"Run my competitive research project — what new M5 Max content dropped this weekend?"*

### Claude Code — Remote Control
Start a Claude Code session with `claude --remote-control`, then continue from any browser or your phone at `claude.ai/code`. Full tool access, full context.

> **Note:** Your Mac must be awake with Claude Desktop open for Cowork, Dispatch, and scheduled tasks to execute.

---

## 🏗️ Architecture

### System Overview

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/arch-system-overview.png" alt="VidLens System Overview" width="800" />
</p>

### How the Fallback Chain Works

Every tool that touches YouTube data uses the same resilience pattern:

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/arch-fallback-chain.png" alt="VidLens Fallback Chain" width="800" />
</p>

Every response includes a `provenance` field telling you exactly which tier served the data and whether anything was partial. No silent degradation — you always know what happened.

### Visual Search Pipeline

Visual search is not transcript reuse. It's a dedicated three-layer index:

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/arch-visual-pipeline.png" alt="VidLens Visual Search Pipeline" width="800" />
</p>

**Three layers, all real:**
1. **Apple Vision feature prints** — image-to-image similarity (find frames that *look* alike)
2. **Gemini Vision frame descriptions** — natural language scene understanding per frame
3. **Gemini semantic embeddings** — 768-dim retrieval over OCR + description text

### Data Storage

Everything lives in a single directory. No external databases, no Docker, no infrastructure.

<p align="center">
  <img src="https://raw.githubusercontent.com/thatsrajan/vidlens-mcp/main/assets/arch-data-storage.png" alt="VidLens Data Storage" width="600" />
</p>

One directory. Portable. Back it up by copying. Delete it to start fresh.

---

## 📋 Requirements

| Requirement | Status | Notes |
|---|---|---|
| **Node.js ≥ 22** | Required | Uses `node:sqlite` — `node --version` to check |
| **yt-dlp** | Auto-installed | Downloaded automatically during `npx vidlens-mcp setup` |
| **ffmpeg + ffprobe** | Recommended for universal video | Needed for Instagram/TikTok/X reels, local video files, STT audio chunking, frame extraction, and visual indexing. Setup/doctor detects it and suggests `brew install ffmpeg` on macOS |
| **YouTube API key** | Optional | Unlocks comments, better metadata |
| **Gemini API key** | Optional | Upgrades transcript embeddings and frame descriptions for visual search |
| **macOS Apple Vision** | Automatic on macOS | Powers native OCR and image similarity for visual search |

---

## 🔧 Troubleshooting

### "Tool not found" in Claude Desktop
Fully quit Claude Desktop (⌘Q, not just close window) and reopen. MCP servers only load on startup.

### "YOUTUBE_API_KEY not configured" warning
This is informational, not an error. VidLens works without it. Add a key only if you need comments/sentiment features.

### "API_KEY_SERVICE_BLOCKED" error
Your API key has restrictions. Create a new **unrestricted** key in Google Cloud Console, or remove the API restriction from the existing key.

### Gemini key doesn't work for YouTube API
These are **separate services**. You need a YouTube API key from Google Cloud Console AND a Gemini key from Google AI Studio. They are not interchangeable.

### Build errors
```bash
npx vidlens-mcp doctor     # Run diagnostics
npx vidlens-mcp doctor --no-live  # Skip network checks
```

### Instagram/TikTok/X reel downloads but visual analysis fails
Install ffmpeg/ffprobe, then rerun setup or doctor:

```bash
brew install ffmpeg
vidlens-mcp setup
vidlens-mcp doctor --no-live
```

`downloadAsset` can often fetch the video without ffmpeg, but `indexVisualContent`, `extractKeyframes`, local-file ingestion, and STT chunking need ffmpeg/ffprobe.

---

## 📄 License

MIT

---

<p align="center">
  <a href="https://github.com/thatsrajan/vidlens-mcp">GitHub</a> ·
  <a href="https://www.npmjs.com/package/vidlens-mcp">npm</a> ·
  <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</p>
