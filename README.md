<p align="center">
  <img src="https://raw.githubusercontent.com/rajanrengasamy/vidlens-mcp/main/assets/readme-banner.png" alt="VidLens — The YouTube intelligence layer for AI agents" width="800" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vidlens-mcp"><img src="https://img.shields.io/npm/v/vidlens-mcp?style=flat-square&color=red" alt="npm" /></a>
  <a href="https://github.com/rajanrengasamy/vidlens-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-green?style=flat-square" alt="MCP" /></a>
  <img src="https://img.shields.io/badge/tools-41-orange?style=flat-square" alt="41 tools" />
  <img src="https://img.shields.io/badge/zero--config-✓-brightgreen?style=flat-square" alt="Zero Config" />
</p>

---

## 🔍 What is VidLens?

VidLens is a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI agents deep, reliable access to YouTube. Not just transcripts - full intelligence: sentiment analysis, trend discovery, semantic search, media assets, creator analytics, and image-backed visual search.

**No API key required to start.** Every tool has a three-tier fallback chain (YouTube API → yt-dlp → page extraction) so nothing breaks when quota runs out or keys aren't configured.
Heavy subsystems are lazy-loaded, repeat read paths are cached, and the visual pipeline is optimized to reduce user-visible wait time.

---

## 🎯 Core Capabilities

### 🔎 Semantic Search Across Playlists
Import entire playlists or video sets, index every transcript with Gemini embeddings, and search across hundreds of hours of content by meaning — not just keywords.

> *"Find every mention of gradient descent across 50 Stanford CS lectures"*
>
> *"What did the instructor say about backpropagation in any of these videos?"*

### 👁️ Visual Search — See What's In Videos
Extract keyframes, describe them with Gemini Vision, run OCR on slides and whiteboards, and search by what you **see** — not just what's said. Three layers: Apple Vision feature prints for image similarity, Gemini frame descriptions for scene understanding, and semantic embeddings for text→visual search.

> *"Find the frame where he draws the system architecture diagram"*
>
> *"Show me every slide that mentions 'transformer architecture'"*

### 📊 Intelligence Layer — Not Just Data
Sentiment analysis with themes and risk signals. Niche trend discovery with momentum and saturation scoring. Content gap detection. Hook pattern analysis. Upload timing recommendations. The LLM does the thinking — VidLens gives it the right data.

> *"What's the audience sentiment on this video? Any risk signals?"*
>
> *"What's trending in the AI coding niche right now?"*

### ⚡ Zero Config, Always Works
No API key needed to start. Three-tier fallback chain on every tool: YouTube API → yt-dlp → page extraction. Nothing breaks when quota runs out. Keys are optional power-ups, not requirements.

### 🎬 Full Media Pipeline
Download videos/audio/thumbnails. Extract keyframes. Index comments for semantic search. Build a local knowledge base from any YouTube content — all through natural language.

---

## ⚡ Why VidLens?

<table>
<tr><th></th><th>VidLens</th><th>Other YouTube MCP servers</th></tr>
<tr><td>🔑 <strong>Setup</strong></td><td>✅ Works immediately - no keys needed</td><td>❌ Most require YouTube API key upfront</td></tr>
<tr><td>🛡️ <strong>Reliability</strong></td><td>✅ Three-tier fallback on every tool</td><td>❌ Single point of failure - API down = broken</td></tr>
<tr><td>🧠 <strong>Intelligence</strong></td><td>✅ Sentiment, trends, content gaps, hooks</td><td>❌ Raw data dumps - you do the analysis</td></tr>
<tr><td>📦 <strong>Token efficiency</strong></td><td>✅ 75-87% smaller responses</td><td>❌ Verbose JSON with thumbnails, etags, junk</td></tr>
<tr><td>🔬 <strong>Depth</strong></td><td>✅ 41 tools across 10 modules</td><td>⚠️ 1-5 tools, mostly transcripts only</td></tr>
<tr><td>🖼️ <strong>Visual evidence</strong></td><td>✅ Returns actual frame paths + timestamps, not just text hits</td><td>⚠️ Usually transcript-only or raw frame dumps</td></tr>
<tr><td>⚖️ <strong>Trademark</strong></td><td>✅ Compliant naming</td><td>⚠️ Most violate YouTube trademark</td></tr>
</table>

---

## 🚀 Quick Start

### 1. Install

```bash
npx vidlens-mcp setup
```

This auto-detects your MCP clients (Claude Desktop, Claude Code) and configures both.

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

**Claude Code** — add to `~/.claude/settings.json`:

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

### 3. Restart your MCP client

Fully quit and reopen Claude Desktop (⌘Q). Claude Code picks up changes automatically.

### 4. Try it

> "Import this playlist and search across all videos for mentions of machine learning"
>
> "Search this video's visuals for the whiteboard architecture diagram and show me the frame evidence"
>
> "What's trending in the AI coding niche right now?"
>
> "Build a complete dossier for this video — metadata, transcript, sentiment, hooks, everything"
>
> "What's the audience sentiment on this video? Any risk signals?"
>
> "Get the transcript of this video: https://youtube.com/watch?v=dQw4w9WgXcQ"

---

## 🧰 Tools - 41 across 9 modules

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

### 🎬 Media Assets
*Download and manage video files locally*

| Tool | What it does |
|---|---|
| `downloadAsset` | Download video, audio, or thumbnails |
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

> ⚠️ **These are separate keys from separate Google services.** A Gemini key will NOT work for YouTube API calls and vice versa. Create them independently.

```bash
# Configure via setup wizard
npx vidlens-mcp setup --youtube-api-key YOUR_YOUTUBE_KEY --gemini-api-key YOUR_GEMINI_KEY

# Or via environment variables
export YOUTUBE_API_KEY=your_youtube_key
export GEMINI_API_KEY=your_gemini_key
```

---

## 💻 CLI

```bash
npx vidlens-mcp               # Start MCP server (stdio)
npx vidlens-mcp serve         # Start MCP server (explicit)
npx vidlens-mcp setup         # Auto-configure Claude Desktop + Claude Code
npx vidlens-mcp doctor        # Run diagnostics
npx vidlens-mcp version       # Print version
npx vidlens-mcp help          # Usage guide
```

### Doctor - diagnose issues

```bash
npx vidlens-mcp doctor --no-live
```

Checks: Node.js version, yt-dlp availability, API key validation, data directory health, MCP client registration (Claude Desktop, Claude Code).

---

## 🏗️ Architecture

### System Overview

<p align="center">
  <img src="https://raw.githubusercontent.com/rajanrengasamy/vidlens-mcp/main/assets/arch-system-overview.png" alt="VidLens System Overview" width="800" />
</p>

### How the Fallback Chain Works

Every tool that touches YouTube data uses the same resilience pattern:

<p align="center">
  <img src="https://raw.githubusercontent.com/rajanrengasamy/vidlens-mcp/main/assets/arch-fallback-chain.png" alt="VidLens Fallback Chain" width="800" />
</p>

Every response includes a `provenance` field telling you exactly which tier served the data and whether anything was partial. No silent degradation — you always know what happened.

### Visual Search Pipeline

Visual search is not transcript reuse. It's a dedicated three-layer index:

<p align="center">
  <img src="https://raw.githubusercontent.com/rajanrengasamy/vidlens-mcp/main/assets/arch-visual-pipeline.png" alt="VidLens Visual Search Pipeline" width="800" />
</p>

**Three layers, all real:**
1. **Apple Vision feature prints** — image-to-image similarity (find frames that *look* alike)
2. **Gemini Vision frame descriptions** — natural language scene understanding per frame
3. **Gemini semantic embeddings** — 768-dim retrieval over OCR + description text

### Data Storage

Everything lives in a single directory. No external databases, no Docker, no infrastructure.

<p align="center">
  <img src="https://raw.githubusercontent.com/rajanrengasamy/vidlens-mcp/main/assets/arch-data-storage.png" alt="VidLens Data Storage" width="600" />
</p>

One directory. Portable. Back it up by copying. Delete it to start fresh.

---

## 📋 Requirements

| Requirement | Status | Notes |
|---|---|---|
| **Node.js ≥ 22** | Required | Uses `node:sqlite` — `node --version` to check |
| **yt-dlp** | Recommended | `brew install yt-dlp` - enables zero-config mode |
| **ffmpeg** | Optional | Needed for frame extraction and visual indexing |
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

---

## 📄 License

MIT

---

<p align="center">
  <a href="https://github.com/rajanrengasamy/vidlens-mcp">GitHub</a> ·
  <a href="https://www.npmjs.com/package/vidlens-mcp">npm</a> ·
  <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</p>
