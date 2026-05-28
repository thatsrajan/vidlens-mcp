import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

export interface VisualReportFrame {
  framePath: string;
  videoId: string;
  videoTitle?: string;
  timestampSec: number;
  timestampLabel?: string;
  ocrText?: string;
  description?: string;
  score?: number;
  matchedOn?: string[];
  sourceVideoUrl?: string;
}

export interface VisualReportOptions {
  query: string;
  frames: VisualReportFrame[];
  outputDir?: string;
  autoOpen?: boolean;
  reportType?: "search" | "index";
  searchMeta?: {
    searchedFrames?: number;
    searchedVideos?: number;
    queryMode?: string;
  };
}

function mimeForExt(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function youtubeTimestampUrl(videoId: string, sec: number): string {
  return `https://youtu.be/${videoId}?t=${Math.floor(sec)}`;
}

function frameTargetUrl(frame: VisualReportFrame): string {
  const sourceUrl = frame.sourceVideoUrl?.trim();
  const seconds = Math.max(0, Math.floor(frame.timestampSec));
  if (!sourceUrl) {
    return youtubeTimestampUrl(frame.videoId, seconds);
  }

  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be" || host.endsWith("youtube.com")) {
      url.searchParams.set("t", String(seconds));
      return url.toString();
    }
    if (host === "x.com" || host === "twitter.com") {
      url.searchParams.set("t", `${seconds}s`);
      return url.toString();
    }
    return sourceUrl;
  } catch {
    return sourceUrl || youtubeTimestampUrl(frame.videoId, seconds);
  }
}

function scoreColor(score?: number): string {
  if (!score) return "#6b7280";
  if (score >= 0.8) return "#22c55e";
  if (score >= 0.5) return "#eab308";
  return "#f97316";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generateVisualReport(options: VisualReportOptions): { html: string; filePath: string } {
  const outputDir = options.outputDir ?? join(homedir(), "Downloads", "vidlens-results");
  mkdirSync(outputDir, { recursive: true });

  const slug = slugify(options.query);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `${slug}-${timestamp}.html`;
  const filePath = join(outputDir, fileName);

  // Read frame images as base64
  const frameData: Array<VisualReportFrame & { base64?: string; mimeType?: string }> = [];
  for (const frame of options.frames) {
    if (frame.framePath && existsSync(frame.framePath)) {
      try {
        const raw = readFileSync(frame.framePath);
        frameData.push({
          ...frame,
          base64: raw.toString("base64"),
          mimeType: mimeForExt(frame.framePath),
        });
      } catch {
        frameData.push(frame);
      }
    } else {
      frameData.push(frame);
    }
  }

  const isSearch = options.reportType !== "index";
  const title = isSearch ? `Visual Search: ${options.query}` : `Visual Index: ${options.query}`;

  const frameCards = frameData.map((frame, i) => {
    const targetUrl = frameTargetUrl(frame);
    const ts = frame.timestampLabel ?? formatTimestamp(frame.timestampSec);
    const imgTag = frame.base64
      ? `<img src="data:${frame.mimeType};base64,${frame.base64}" alt="Frame at ${ts}" loading="lazy" />`
      : `<div class="no-image">Frame not available on disk</div>`;

    const scoreBadge = frame.score != null
      ? `<span class="score" style="background:${scoreColor(frame.score)}">${(frame.score * 100).toFixed(0)}%</span>`
      : "";

    const matchBadges = (frame.matchedOn ?? [])
      .map(m => `<span class="badge">${escapeHtml(m)}</span>`)
      .join("");

    return `
      <div class="card">
        <div class="card-image">
          <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener">${imgTag}</a>
          <div class="overlay">
            <a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener" class="timestamp">${escapeHtml(ts)}</a>
            ${scoreBadge}
          </div>
        </div>
        <div class="card-body">
          <div class="video-title">${escapeHtml(frame.videoTitle ?? frame.videoId)}</div>
          ${matchBadges ? `<div class="badges">${matchBadges}</div>` : ""}
          ${frame.description ? `<p class="description">${escapeHtml(frame.description)}</p>` : ""}
          ${frame.ocrText ? `<details><summary class="ocr-toggle">OCR Text</summary><pre class="ocr">${escapeHtml(frame.ocrText)}</pre></details>` : ""}
        </div>
      </div>`;
  }).join("\n");

  const meta = options.searchMeta;
  const metaLine = meta
    ? `<p class="meta">Searched ${meta.searchedFrames ?? "?"} frames across ${meta.searchedVideos ?? "?"} videos · Mode: ${meta.queryMode ?? "unknown"}</p>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — VidLens</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #0f0f14;
      color: #e4e4e7;
      min-height: 100vh;
      padding: 0;
    }

    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-bottom: 1px solid #2a2a3e;
      padding: 2rem 2rem 1.5rem;
    }

    .header-inner {
      max-width: 1400px;
      margin: 0 auto;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: #71717a;
      margin-bottom: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .brand svg {
      width: 18px;
      height: 18px;
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 0.5rem;
    }

    h1 .query {
      color: #a78bfa;
    }

    .meta {
      font-size: 0.85rem;
      color: #71717a;
    }

    .results-count {
      font-size: 0.95rem;
      color: #a1a1aa;
      margin-top: 0.25rem;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 1.5rem;
    }

    .card {
      background: #1c1c24;
      border: 1px solid #2a2a3e;
      border-radius: 12px;
      overflow: hidden;
      transition: border-color 0.2s, transform 0.2s;
    }

    .card:hover {
      border-color: #a78bfa;
      transform: translateY(-2px);
    }

    .card-image {
      position: relative;
      background: #0a0a0f;
    }

    .card-image img {
      width: 100%;
      height: auto;
      display: block;
    }

    .card-image .no-image {
      padding: 4rem 2rem;
      text-align: center;
      color: #52525b;
      font-style: italic;
    }

    .overlay {
      position: absolute;
      top: 0.75rem;
      left: 0.75rem;
      right: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      pointer-events: none;
    }

    .overlay > * {
      pointer-events: auto;
    }

    .timestamp {
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(4px);
      color: #fff;
      padding: 0.3rem 0.6rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      text-decoration: none;
      font-variant-numeric: tabular-nums;
      transition: background 0.2s;
    }

    .timestamp:hover {
      background: #a78bfa;
    }

    .score {
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 700;
      color: #fff;
    }

    .card-body {
      padding: 1rem 1.25rem 1.25rem;
    }

    .video-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: #d4d4d8;
      margin-bottom: 0.5rem;
      line-height: 1.4;
    }

    .badges {
      display: flex;
      gap: 0.35rem;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }

    .badge {
      background: #2a2a3e;
      color: #a78bfa;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .description {
      font-size: 0.85rem;
      color: #a1a1aa;
      line-height: 1.5;
      margin-bottom: 0.5rem;
    }

    .ocr-toggle {
      font-size: 0.8rem;
      color: #71717a;
      cursor: pointer;
      user-select: none;
    }

    .ocr-toggle:hover {
      color: #a78bfa;
    }

    .ocr {
      font-size: 0.75rem;
      color: #52525b;
      background: #0f0f14;
      border: 1px solid #2a2a3e;
      border-radius: 6px;
      padding: 0.75rem;
      margin-top: 0.5rem;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 150px;
      overflow-y: auto;
    }

    .footer {
      text-align: center;
      padding: 2rem;
      color: #3f3f46;
      font-size: 0.8rem;
    }

    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .header { padding: 1.5rem 1rem 1rem; }
      .container { padding: 1rem; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <div class="brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        VidLens Visual ${isSearch ? "Search" : "Index"}
      </div>
      <h1>${isSearch ? `Results for <span class="query">"${escapeHtml(options.query)}"</span>` : escapeHtml(options.query)}</h1>
      <p class="results-count">${frameData.length} frame${frameData.length === 1 ? "" : "s"} found</p>
      ${metaLine}
    </div>
  </div>

  <div class="container">
    <div class="grid">
      ${frameCards}
    </div>
  </div>

  <div class="footer">
    Generated by VidLens MCP · ${new Date().toLocaleString()} · Timestamps link to YouTube
  </div>
</body>
</html>`;

  writeFileSync(filePath, html, "utf8");
  return { html, filePath };
}

export async function openInBrowser(filePath: string): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    if (process.platform === "darwin") {
      execSync(`open "${filePath}"`, { timeout: 5_000 });
    } else if (process.platform === "win32") {
      execSync(`start "" "${filePath}"`, { timeout: 5_000 });
    } else {
      execSync(`xdg-open "${filePath}"`, { timeout: 5_000 });
    }
  } catch {
    // Silently fail — user can open manually
  }
}
