/**
 * Media Downloader — yt-dlp wrapper for downloading video/audio/thumbnail files.
 *
 * Downloads go to the MediaStore's asset directory, then get registered in the manifest.
 * This module intentionally does NOT do frame-level visual indexing — it downloads
 * and stores media files. Visual search is handled separately by the visual-search layer.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { execa } from "execa";
import { MediaStore, type AssetKind, type MediaAsset } from "./media-store.js";
import { buildVideoUrl, parseVideoId } from "./id-parsing.js";

/* ── Types ─────────────────────────────────────────────────────── */

export type DownloadFormat = "best_video" | "best_audio" | "thumbnail" | "worst_video";

export interface DownloadOptions {
  videoIdOrUrl: string;
  format: DownloadFormat;
  /** Override output directory (default: store.videoDir(videoId)) */
  outputDir?: string;
  /** Max file size in MB. Downloads exceeding this are rejected. Default: 500 */
  maxSizeMb?: number;
}

export interface DownloadResult {
  asset: MediaAsset;
  downloadedBytes: number;
  durationMs: number;
}

/* ── Downloader ────────────────────────────────────────────────── */

export class MediaDownloader {
  constructor(
    private readonly store: MediaStore,
    private readonly ytdlpBinary = "yt-dlp",
  ) {}

  /**
   * Download a media asset for a YouTube video and register it in the manifest.
   */
  async download(options: DownloadOptions): Promise<DownloadResult> {
    const videoId = parseVideoId(options.videoIdOrUrl) ?? options.videoIdOrUrl;
    const url = videoId.startsWith("http") ? videoId : buildVideoUrl(videoId);
    const outDir = options.outputDir ?? this.store.videoDir(videoId);
    const maxSizeMb = options.maxSizeMb ?? 500;
    const startMs = Date.now();

    // Check if we already have this kind for this video
    const existing = this.store.listAssetsForVideo(videoId);
    const kind = formatToKind(options.format);
    const alreadyHave = existing.find(
      (a) => a.kind === kind && existsSync(a.filePath),
    );
    if (alreadyHave) {
      return {
        asset: alreadyHave,
        downloadedBytes: 0,
        durationMs: Date.now() - startMs,
      };
    }

    if (options.format === "thumbnail") {
      return this.downloadThumbnail(videoId, url, outDir, startMs);
    }

    // Build yt-dlp args
    const formatArg = ytdlpFormatArg(options.format);
    const outputTemplate = join(outDir, "%(id)s.%(ext)s");

    const args = [
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      "-f", formatArg,
      "--max-filesize", `${maxSizeMb}M`,
      "-o", outputTemplate,
      url,
    ];

    try {
      await execa(this.ytdlpBinary, args, { timeout: 300_000, reject: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`yt-dlp download failed for ${videoId}: ${message}`);
    }

    // Find the downloaded file
    const downloadedFile = findDownloadedFile(outDir, videoId);
    if (!downloadedFile) {
      throw new Error(`Download appeared to succeed but no file found in ${outDir} for ${videoId}`);
    }

    const filePath = join(outDir, downloadedFile);
    const stat = statSync(filePath);

    // Get duration from yt-dlp metadata
    let durationSec: number | undefined;
    try {
      const { stdout } = await execa(this.ytdlpBinary, [
        "--dump-single-json", "--skip-download", "--no-warnings", url,
      ], { timeout: 30_000 });
      const meta = JSON.parse(stdout) as { duration?: number };
      durationSec = meta.duration;
    } catch {
      // non-critical
    }

    const asset = this.store.registerAsset({
      videoId,
      kind,
      filePath,
      durationSec,
    });

    return {
      asset,
      downloadedBytes: stat.size,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Download the YouTube thumbnail image for a video.
   */
  private async downloadThumbnail(
    videoId: string,
    url: string,
    outDir: string,
    startMs: number,
  ): Promise<DownloadResult> {
    const outputTemplate = join(outDir, `${videoId}-thumb.%(ext)s`);

    const args = [
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "--write-thumbnail",
      "--convert-thumbnails", "jpg",
      "-o", outputTemplate,
      url,
    ];

    try {
      await execa(this.ytdlpBinary, args, { timeout: 60_000, reject: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Thumbnail download failed for ${videoId}: ${message}`);
    }

    const thumbFile = findFile(outDir, `${videoId}-thumb`);
    if (!thumbFile) {
      throw new Error(`Thumbnail download appeared to succeed but no file found for ${videoId}`);
    }

    const filePath = join(outDir, thumbFile);
    const stat = statSync(filePath);

    // Try to get dimensions
    let width: number | undefined;
    let height: number | undefined;
    try {
      const { stdout } = await execa("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "json",
        filePath,
      ], { timeout: 10_000 });
      const probe = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
      width = probe.streams?.[0]?.width;
      height = probe.streams?.[0]?.height;
    } catch {
      // non-critical
    }

    const asset = this.store.registerAsset({
      videoId,
      kind: "thumbnail",
      filePath,
      width,
      height,
    });

    return {
      asset,
      downloadedBytes: stat.size,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Probe whether yt-dlp is available and return its version.
   */
  async probe(): Promise<{ binary: string; version: string }> {
    const { stdout } = await execa(this.ytdlpBinary, ["--version"], {
      timeout: 30_000,
      reject: true,
    });
    return { binary: this.ytdlpBinary, version: stdout.trim() };
  }
}

/* ── Helpers ───────────────────────────────────────────────────── */

function formatToKind(format: DownloadFormat): AssetKind {
  switch (format) {
    case "best_video":
    case "worst_video":
      return "video";
    case "best_audio":
      return "audio";
    case "thumbnail":
      return "thumbnail";
  }
}

function ytdlpFormatArg(format: DownloadFormat): string {
  switch (format) {
    case "best_video":
      return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
    case "worst_video":
      return "worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst";
    case "best_audio":
      return "bestaudio[ext=m4a]/bestaudio/best";
    case "thumbnail":
      return "best"; // not used for thumbnail path
  }
}

function findDownloadedFile(dir: string, videoId: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir);
  const isUsable = (f: string) => !f.includes("-thumb") && !f.endsWith(".part") && !f.startsWith(".");
  // Prefer files matching the video ID (skip .part and intermediate format files)
  const match = files.find((f) => f.startsWith(videoId) && isUsable(f));
  if (match) return match;
  // Fallback: newest usable file
  const candidates = files
    .filter(isUsable)
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.name;
}

function findFile(dir: string, prefix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).find((f) => f.startsWith(prefix));
}
