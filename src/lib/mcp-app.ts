import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const VIDEO_EVIDENCE_APP_URI = "ui://vidlens/video-evidence-v1.html";

const MAX_FRAME_RESOURCES = 200;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

export interface VideoEvidenceFrame {
  rank: number;
  imageUri?: string;
  videoId: string;
  videoTitle?: string;
  timestampSec: number;
  timestampLabel: string;
  score?: number;
  matchedOn: string[];
  ocrText?: string;
  description?: string;
  explanation?: string;
  sourceVideoUrl?: string;
}

export interface VideoEvidenceView {
  [key: string]: unknown;
  kind: "vidlens.video-evidence";
  schemaVersion: 1;
  query: string;
  resultCount: number;
  frames: VideoEvidenceFrame[];
  searchMeta: {
    searchedFrames?: number;
    searchedVideos?: number;
    queryMode?: string;
    embeddingProvider?: string;
  };
  coveredTimeRange?: { startSec: number; endSec: number };
  needsExpansion?: boolean;
  limitations: string[];
  provenance?: Record<string, unknown>;
  timing?: { elapsedMs?: number; tier?: string };
}

interface StoredFrameResource {
  uri: string;
  framePath: string;
  mimeType: string;
  name: string;
  description: string;
}

export interface EvidenceFrameReadResult {
  uri: string;
  mimeType: string;
  blob: string;
}

export class EvidenceFrameResourceStore {
  private readonly entries = new Map<string, StoredFrameResource>();

  register(framePath: string, metadata: { videoTitle?: string; timestampLabel?: string }): string | undefined {
    if (!framePath || !existsSync(framePath)) return undefined;

    let stat;
    try {
      stat = statSync(framePath);
    } catch {
      return undefined;
    }
    if (!stat.isFile() || stat.size > MAX_FRAME_BYTES) return undefined;

    const fingerprint = createHash("sha256")
      .update(`${framePath}\0${stat.size}\0${stat.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
    const uri = `vidlens-frame://evidence/${fingerprint}`;
    const entry: StoredFrameResource = {
      uri,
      framePath,
      mimeType: mimeForPath(framePath),
      name: `VidLens frame ${metadata.timestampLabel ?? fingerprint}`,
      description: [metadata.videoTitle, metadata.timestampLabel].filter(Boolean).join(" at "),
    };

    this.entries.delete(uri);
    this.entries.set(uri, entry);
    while (this.entries.size > MAX_FRAME_RESOURCES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return uri;
  }

  list(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
    return [...this.entries.values()].map(({ uri, name, description, mimeType }) => ({
      uri,
      name,
      description,
      mimeType,
    }));
  }

  read(uri: string): EvidenceFrameReadResult | undefined {
    const entry = this.entries.get(uri);
    if (!entry || !existsSync(entry.framePath)) return undefined;

    let stat;
    try {
      stat = statSync(entry.framePath);
    } catch {
      return undefined;
    }
    if (!stat.isFile() || stat.size > MAX_FRAME_BYTES) return undefined;

    this.entries.delete(uri);
    this.entries.set(uri, entry);
    return {
      uri,
      mimeType: entry.mimeType,
      blob: readFileSync(entry.framePath).toString("base64"),
    };
  }
}

export function buildVideoEvidenceView(
  result: Record<string, unknown>,
  resources: EvidenceFrameResourceStore,
): VideoEvidenceView {
  const matches = Array.isArray(result.results)
    ? result.results as Array<Record<string, unknown>>
    : [];
  const searchMeta = isRecord(result.searchMeta) ? result.searchMeta : {};
  const coveredTimeRange = isRecord(result.coveredTimeRange)
    ? {
        startSec: numberOrZero(result.coveredTimeRange.startSec),
        endSec: numberOrZero(result.coveredTimeRange.endSec),
      }
    : undefined;

  const frames = matches.map((match, index): VideoEvidenceFrame => {
    const videoId = stringOrEmpty(match.videoId);
    const timestampSec = numberOrZero(match.timestampSec ?? match.tStartSec);
    const timestampLabel = stringOrEmpty(match.timestampLabel) || formatTimestamp(timestampSec);
    const videoTitle = optionalString(match.sourceVideoTitle ?? match.videoTitle);
    const framePath = stringOrEmpty(match.framePath);
    const imageUri = resources.register(framePath, { videoTitle, timestampLabel });
    const rawScore = match.score ?? match.similarity;

    return {
      rank: index + 1,
      imageUri,
      videoId,
      videoTitle,
      timestampSec,
      timestampLabel,
      score: typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : undefined,
      matchedOn: Array.isArray(match.matchedOn)
        ? match.matchedOn.filter((value): value is string => typeof value === "string")
        : [],
      ocrText: optionalString(match.ocrText),
      description: optionalString(match.visualDescription ?? match.description),
      explanation: optionalString(match.explanation),
      sourceVideoUrl: safeHttpUrl(match.sourceVideoUrl),
    };
  });

  return {
    kind: "vidlens.video-evidence",
    schemaVersion: 1,
    query: stringOrEmpty(result.query) || "visual evidence",
    resultCount: frames.length,
    frames,
    searchMeta: {
      searchedFrames: optionalFiniteNumber(searchMeta.searchedFrames),
      searchedVideos: optionalFiniteNumber(searchMeta.searchedVideos),
      queryMode: optionalString(searchMeta.queryMode ?? searchMeta.similarityEngine),
      embeddingProvider: optionalString(searchMeta.embeddingProvider),
    },
    coveredTimeRange,
    needsExpansion: typeof result.needsExpansion === "boolean" ? result.needsExpansion : undefined,
    limitations: Array.isArray(result.limitations)
      ? result.limitations
          .filter((value): value is string => typeof value === "string")
          .map(sanitizeLimitation)
      : [],
    provenance: isRecord(result.provenance) ? result.provenance : undefined,
    timing: isRecord(result._timing)
      ? {
          elapsedMs: optionalFiniteNumber(result._timing.elapsedMs),
          tier: optionalString(result._timing.tier),
        }
      : undefined,
  };
}

export function loadVideoEvidenceAppHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "ui", "video-evidence-viewer.html"),
    join(here, "..", "..", "dist", "ui", "video-evidence-viewer.html"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("VidLens MCP App bundle is missing. Run `npm run build` and try again.");
}

function mimeForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeLimitation(value: string): string {
  if (/local frame paths?/i.test(value)) {
    return "Dry-run sample only. Real searches expose frame evidence through opaque MCP resources in app-capable hosts and structured metadata elsewhere.";
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
