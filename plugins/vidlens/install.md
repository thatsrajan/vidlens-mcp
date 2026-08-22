# VidLens Codex Plugin Install Notes

VidLens exposes the same MCP server to Claude, Codex CLI, and Codex Desktop.

## Development Checkout

To run the MCP server directly from a checkout:

```sh
npm install
npm run build
npm run setup -- --client codex
```

Then register the checkout with `npm run setup -- --client codex`; the setup helper writes the
checkout-aware command into Codex configuration. The distributed plugin manifest intentionally
contains only the portable release command accepted by Codex plugin validation.

If you want the bare `vidlens-mcp` command from a checkout, run `npm install -g .` or `npm link` once. A plain `npm install` only installs dependencies.

## Distributed Plugin

The plugin runs:

```sh
npx -y vidlens-mcp serve
```

That is the portable path for installed Codex users and does not depend on a local checkout.

## Setup Helper

`vidlens-mcp setup --client codex` writes the MCP server registration, a local plugin marketplace entry, and the `vidlens@vidlens-local` enablement block into `~/.codex/config.toml`.

VidLens Free setup covers public YouTube transcripts, search, and metadata through managed `yt-dlp` without API keys. As you ask it to handle more kinds of video, some capabilities need an uplift:

- `ffmpeg` / `ffprobe`: Instagram/TikTok/X reels, local video files, audio chunking, keyframe extraction, and visual indexing.
- `YOUTUBE_API_KEY`: better YouTube metadata, API search, and subscriber counts.
- `GEMINI_API_KEY`: semantic search, visual search, AI frame descriptions, and Gemini STT fallback.
- `OPENAI_API_KEY`: speech-to-text fallback for X/Instagram/TikTok, generic URLs, and local video files with no captions.
- `SCRAPECREATORS_API_KEY`: direct social trend search across TikTok, Instagram, Threads, Pinterest, Reddit, and supported ScrapeCreators endpoints.
- `BRAVE_API_KEY` or `SERPAPI_KEY`: structured web discovery for finding social/generic video URLs by query.
- Browser cookies: logged-in, gated, age-limited, or rate-limited social videos.

For an individual social video, the distributed agent skill follows this order automatically:

1. reuse anything already in the local VidLens library;
2. try the exact public post URL through yt-dlp with no key;
3. use Browser/Chrome control, when the host provides it, to find or verify the canonical post URL;
4. retry with configured cookies or import a permitted local-file download;
5. use configured APIs for scale and reliability.

Browser assistance is a client-side workflow, not a hidden scraper inside the MCP server. Codex or
Claude installations without browser control still retain direct-URL and local-file ingestion.

Interactive setup offers a simple choice: **Free** (recommended, no API keys) or **Enhanced**. Press Enter for Free. Enhanced walks through optional services one at a time, lets you skip any item, preserves saved values without displaying them, and masks API-key input.

To intentionally add optional auth/search/STT/cookie settings, pass explicit flags such as `--openai-api-key`, `--brave-api-key`, or `--cookies-from-browser`, or run:

```sh
vidlens-mcp setup --client codex --enhanced
```

The Enhanced wizard can collect and persist optional YouTube, Gemini, OpenAI, Brave/SerpAPI, STT, browser-cookie, and platform-cookie settings into the generated MCP env block. `--advanced` remains available as a compatibility alias.

Use `--print-only` to review the TOML before writing. Secret values are redacted in review output.

For Claude Code, run:

```sh
vidlens-mcp setup --client claude_code
```

When the `claude` CLI is available and the config has no secret env values, setup registers VidLens through Claude Code's own user MCP registry with `claude mcp add-json --scope user`. If API keys or cookie settings are present, setup writes `~/.claude.json` directly so secrets are not passed through command arguments. Both paths install or update the bundled `vidlens-workflows` skill under `~/.claude/skills/`, keeping timestamped backups of the three newest replaced copies, and check `claude mcp list` afterward when possible. After setup, start a new Claude Code session or rerun `/mcp`.

Setup also checks for `ffmpeg` and `ffprobe`. They are strongly recommended for Instagram/TikTok/X reels, local video files, STT audio chunking, keyframe extraction, and visual indexing. On macOS:

```sh
brew install ffmpeg
vidlens-mcp doctor --no-live
```

Recommended Enhanced setup answers:

- STT provider: press Enter for `auto`; setup checks local whisper.cpp, then Gemini, then OpenAI after you answer.
- Default STT language hint: use `en` for mostly English videos, or press Enter to auto-detect.
- whisper.cpp model path: press Enter unless you already have a local model file.
- Web search provider: press Enter for `auto`; setup checks Brave/SerpAPI keys, then DuckDuckGo-lite.
- Browser cookies: enter the browser where you are logged into X/Instagram/TikTok, usually `chrome`.
- Browser profile: press Enter unless you use a named profile.
- Platform-specific cookie files: answer `n` unless you already exported Netscape-format cookie files.
