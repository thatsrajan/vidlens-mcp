import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildVideoUrl, parseVideoId } from "./id-parsing.js";

export type VideoSourcePlatform =
  | "youtube"
  | "x"
  | "instagram"
  | "tiktok"
  | "generic_url"
  | "local_file";

export interface VideoSourceCapabilities {
  search: "native" | "web_fallback" | "local_index" | "unsupported";
  inspect: boolean;
  download: boolean;
  transcript: boolean;
  transcriptMode?: "native" | "stt" | "unsupported";
  comments: boolean;
  thumbnail: boolean;
  visualIndex: boolean;
  requiresAuth: boolean;
  authModes: Array<"none" | "cookies" | "api_key">;
  notes: string[];
}

export interface VideoSourceRef {
  input: string;
  platform: VideoSourcePlatform;
  sourceId: string;
  assetKey: string;
  canonicalUrl: string;
  sourceUrl?: string;
  localPath?: string;
  titleHint?: string;
  capabilities: VideoSourceCapabilities;
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
]);

export function resolveVideoSource(input: string, cwd = process.cwd()): VideoSourceRef {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Video source cannot be empty.");
  }

  const local = resolveLocalFile(raw, cwd);
  if (local) {
    const sourceId = shortHash(local.path);
    return {
      input: raw,
      platform: "local_file",
      sourceId,
      assetKey: `local_${sourceId}`,
      canonicalUrl: pathToFileURL(local.path).toString(),
      localPath: local.path,
      titleHint: basename(local.path),
      capabilities: capabilitiesForPlatform("local_file"),
    };
  }

  const url = maybeUrl(raw);
  if (!url) {
    const youtubeId = parseVideoId(raw);
    if (youtubeId) {
      return {
        input: raw,
        platform: "youtube",
        sourceId: youtubeId,
        assetKey: youtubeId,
        canonicalUrl: buildVideoUrl(youtubeId),
        sourceUrl: buildVideoUrl(youtubeId),
        capabilities: capabilitiesForPlatform("youtube"),
      };
    }
    throw new Error(`Unsupported video source: ${input}`);
  }

  const platform = platformForUrl(url);
  if (platform === "youtube") {
    const youtubeId = parseVideoId(url.toString());
    if (!youtubeId) {
      throw new Error(`Unsupported YouTube video source: ${input}`);
    }
    return {
      input: raw,
      platform: "youtube",
      sourceId: youtubeId,
      assetKey: youtubeId,
      canonicalUrl: buildVideoUrl(youtubeId),
      sourceUrl: buildVideoUrl(youtubeId),
      capabilities: capabilitiesForPlatform("youtube"),
    };
  }

  const canonicalUrl = canonicalizeUrl(url, platform);
  const sourceId = sourceIdForUrl(url, platform) ?? shortHash(canonicalUrl);
  const prefix = platform === "generic_url" ? "web" : platform;

  return {
    input: raw,
    platform,
    sourceId,
    assetKey: `${prefix}_${sanitizeKey(sourceId)}`,
    canonicalUrl,
    sourceUrl: canonicalUrl,
    capabilities: capabilitiesForPlatform(platform),
  };
}

export function capabilitiesForPlatform(platform: VideoSourcePlatform): VideoSourceCapabilities {
  switch (platform) {
    case "youtube":
      return {
        search: "native",
        inspect: true,
        download: true,
        transcript: true,
        transcriptMode: "native",
        comments: true,
        thumbnail: true,
        visualIndex: true,
        requiresAuth: false,
        authModes: ["none", "cookies", "api_key"],
        notes: [
          "YouTube keeps the full existing VidLens fallback chain.",
          "yt-dlp freshness and a JavaScript runtime improve resilience when YouTube changes extraction.",
        ],
      };
    case "x":
      return {
        search: "web_fallback",
        inspect: true,
        download: true,
        transcript: false,
        transcriptMode: "unsupported",
        comments: false,
        thumbnail: true,
        visualIndex: true,
        requiresAuth: false,
        authModes: ["none", "cookies", "api_key"],
        notes: ["Public posts are attempted first; cookies may be needed for age-gated, private, or rate-limited content."],
      };
    case "instagram":
      return {
        search: "web_fallback",
        inspect: true,
        download: true,
        transcript: false,
        transcriptMode: "unsupported",
        comments: false,
        thumbnail: true,
        visualIndex: true,
        requiresAuth: false,
        authModes: ["none", "cookies"],
        notes: ["Public reels/posts are attempted first; cookies are often required for reliable Instagram access."],
      };
    case "tiktok":
      return {
        search: "web_fallback",
        inspect: true,
        download: true,
        transcript: false,
        transcriptMode: "unsupported",
        comments: false,
        thumbnail: true,
        visualIndex: true,
        requiresAuth: false,
        authModes: ["none", "cookies"],
        notes: ["Public TikTok URLs are attempted through yt-dlp; cookies can help when the platform rate-limits anonymous access."],
      };
    case "local_file":
      return {
        search: "local_index",
        inspect: true,
        download: false,
        transcript: false,
        transcriptMode: "unsupported",
        comments: false,
        thumbnail: true,
        visualIndex: true,
        requiresAuth: false,
        authModes: ["none"],
        notes: ["Local files are copied into the VidLens media store before frame extraction so original files are not deleted by cleanup."],
      };
    case "generic_url":
      return {
        search: "web_fallback",
        inspect: true,
        download: true,
        transcript: false,
        transcriptMode: "unsupported",
        comments: false,
        thumbnail: true,
        visualIndex: true,
        requiresAuth: false,
        authModes: ["none", "cookies"],
        notes: ["Generic URLs use yt-dlp support where available and return clear errors when an extractor is unsupported."],
      };
  }
}

export function isVideoSourceLike(input: string): boolean {
  try {
    resolveVideoSource(input);
    return true;
  } catch {
    return false;
  }
}

/** True when a social URL identifies a post/video, not a profile or explore page. */
export function isConcreteVideoSource(source: VideoSourceRef): boolean {
  if (source.platform === "youtube" || source.platform === "local_file" || source.platform === "generic_url") {
    return true;
  }

  let url: URL;
  try {
    url = new URL(source.canonicalUrl);
  } catch {
    return false;
  }

  const path = url.pathname.replace(/\/+$/, "");
  switch (source.platform) {
    case "x":
      return /\/(?:status|statuses)\/\d+(?:\/video\/\d+)?$/i.test(path);
    case "instagram":
      return /\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+$/i.test(path);
    case "tiktok":
      return /\/@[^/]+\/video\/\d+$/i.test(path)
        || (/^(?:vm|vt)\.tiktok\.com$/i.test(url.hostname) && path.length > 1);
    default:
      return false;
  }
}

function resolveLocalFile(raw: string, cwd: string): { path: string } | null {
  let candidate = raw;
  if (raw.startsWith("file://")) {
    try {
      candidate = fileURLToPath(raw);
    } catch {
      return null;
    }
  }

  const absolute = resolve(cwd, candidate);
  if (!existsSync(absolute)) {
    return null;
  }
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    return null;
  }
  const ext = extname(absolute).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return null;
  }
  return { path: absolute };
}

function maybeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    // continue
  }

  if (/^(youtube\.com|www\.youtube\.com|youtu\.be|x\.com|twitter\.com|www\.instagram\.com|instagram\.com|www\.tiktok\.com|tiktok\.com)\//i.test(raw)) {
    try {
      return new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }

  return null;
}

function platformForUrl(url: URL): VideoSourcePlatform {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be" || hostMatches(host, "youtube.com")) return "youtube";
  if (hostMatches(host, "x.com") || hostMatches(host, "twitter.com")) return "x";
  if (hostMatches(host, "instagram.com")) return "instagram";
  if (hostMatches(host, "tiktok.com")) return "tiktok";
  return "generic_url";
}

/** Suffix match with a dot boundary so `notyoutube.com` does not match `youtube.com`. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

function canonicalizeUrl(url: URL, platform: VideoSourcePlatform): string {
  if (platform === "youtube") {
    const id = parseVideoId(url.toString());
    if (id) return buildVideoUrl(id);
  }
  const clean = new URL(url.toString());
  clean.hash = "";
  // Known platforms identify a video by path, so tracking query params are noise
  // and get stripped. Generic URLs may identify the video *by* query param
  // (e.g. ?video=123), so preserve their query string.
  if (platform !== "generic_url") {
    clean.search = "";
  }
  clean.pathname = clean.pathname.replace(/\/+$/, "");
  return clean.toString();
}

function sourceIdForUrl(url: URL, platform: VideoSourcePlatform): string | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  switch (platform) {
    case "youtube":
      return parseVideoId(url.toString()) ?? undefined;
    case "x": {
      const statusIndex = parts.findIndex((part) => part === "status" || part === "statuses");
      return statusIndex >= 0 ? parts[statusIndex + 1] : undefined;
    }
    case "instagram": {
      const markerIndex = parts.findIndex((part) => ["p", "reel", "reels", "tv"].includes(part));
      return markerIndex >= 0 ? parts[markerIndex + 1] : undefined;
    }
    case "tiktok": {
      const videoIndex = parts.findIndex((part) => part === "video");
      return videoIndex >= 0 ? parts[videoIndex + 1] : undefined;
    }
    case "generic_url":
    case "local_file":
      return undefined;
  }
}

function sanitizeKey(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || shortHash(value);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
