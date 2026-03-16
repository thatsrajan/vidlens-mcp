/**
 * Thumbnail / Keyframe Extractor — uses ffmpeg to extract frames from downloaded videos.
 *
 * Honest boundaries:
 * - Extracts keyframes at specified intervals or I-frame positions
 * - Does NOT do visual search, visual embeddings, or frame classification
 * - Provides raw frame files that can be used by external vision models
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { MediaStore, type MediaAsset } from "./media-store.js";

/* ── Types ─────────────────────────────────────────────────────── */

export interface ExtractKeyframesOptions {
  videoId: string;
  /** Path to the local video file. If omitted, looks up the store. */
  videoPath?: string;
  /** Extract one frame every N seconds. Default: 30 */
  intervalSec?: number;
  /** Max frames to extract. Default: 20 */
  maxFrames?: number;
  /** Image format for output. Default: jpg */
  imageFormat?: "jpg" | "png" | "webp";
  /** Image width (height auto-scaled). Default: 640 */
  width?: number;
}

export interface ExtractKeyframesResult {
  videoId: string;
  framesExtracted: number;
  assets: MediaAsset[];
  durationMs: number;
}

/* ── Extractor ─────────────────────────────────────────────────── */

export class ThumbnailExtractor {
  constructor(
    private readonly store: MediaStore,
    private readonly ffmpegBinary = "ffmpeg",
    private readonly ffprobeBinary = "ffprobe",
  ) {}

  /**
   * Extract keyframes from a downloaded video at regular intervals.
   */
  async extractKeyframes(options: ExtractKeyframesOptions): Promise<ExtractKeyframesResult> {
    const startMs = Date.now();
    const intervalSec = options.intervalSec ?? 30;
    const maxFrames = options.maxFrames ?? 20;
    const imageFormat = options.imageFormat ?? "jpg";
    const width = options.width ?? 1280;

    // Resolve video file path
    const videoPath = options.videoPath ?? this.findVideoFile(options.videoId);
    if (!videoPath || !existsSync(videoPath)) {
      throw new Error(
        `No local video file found for ${options.videoId}. Download the video first with downloadAsset.`,
      );
    }

    // Get video duration
    const durationSec = await this.probeDuration(videoPath);
    if (!durationSec || durationSec <= 0) {
      throw new Error(`Could not determine duration for ${videoPath}`);
    }

    // Calculate timestamps
    const timestamps: number[] = [];
    for (let t = 0; t < durationSec && timestamps.length < maxFrames; t += intervalSec) {
      timestamps.push(t);
    }

    if (timestamps.length === 0) {
      return {
        videoId: options.videoId,
        framesExtracted: 0,
        assets: [],
        durationMs: Date.now() - startMs,
      };
    }

    // Create output directory
    const framesDir = join(this.store.videoDir(options.videoId), "keyframes");
    mkdirSync(framesDir, { recursive: true });

    // Extract all frames in a single ffmpeg call using the select filter
    const selectExpr = timestamps
      .map((t) => `eq(n\\,0)*gte(t\\,${t})`)
      .join("+");

    // Simpler approach: extract at each timestamp individually
    // This is more reliable than complex filter expressions
    const assets: MediaAsset[] = [];

    for (const [index, timestamp] of timestamps.entries()) {
      const outFile = join(
        framesDir,
        `${options.videoId}_${String(index).padStart(4, "0")}_${Math.round(timestamp)}s.${imageFormat}`,
      );

      // Skip if already extracted
      if (existsSync(outFile)) {
        const existing = this.store.listAssetsForVideo(options.videoId)
          .find((a) => a.filePath === outFile);
        if (existing) {
          assets.push(existing);
          continue;
        }
      }

      try {
        await execa(this.ffmpegBinary, [
          "-ss", String(timestamp),
          "-i", videoPath,
          "-vframes", "1",
          "-vf", `scale=${width}:-1`,
          "-q:v", "2",
          "-y",
          outFile,
        ], { timeout: 30_000, reject: true });

        if (existsSync(outFile)) {
          // Get dimensions
          let frameWidth: number | undefined;
          let frameHeight: number | undefined;
          try {
            const { stdout } = await execa(this.ffprobeBinary, [
              "-v", "error",
              "-select_streams", "v:0",
              "-show_entries", "stream=width,height",
              "-of", "json",
              outFile,
            ], { timeout: 10_000 });
            const probe = JSON.parse(stdout) as {
              streams?: Array<{ width?: number; height?: number }>;
            };
            frameWidth = probe.streams?.[0]?.width;
            frameHeight = probe.streams?.[0]?.height;
          } catch {
            // non-critical
          }

          const asset = this.store.registerAsset({
            videoId: options.videoId,
            kind: "keyframe",
            filePath: outFile,
            timestampSec: timestamp,
            width: frameWidth,
            height: frameHeight,
          });
          assets.push(asset);
        }
      } catch {
        // Skip failed frames, continue with others
      }
    }

    return {
      videoId: options.videoId,
      framesExtracted: assets.length,
      assets,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Check if ffmpeg is available.
   */
  async probe(): Promise<{ ffmpeg: string; ffprobe: string }> {
    const [ffmpegResult, ffprobeResult] = await Promise.all([
      execa(this.ffmpegBinary, ["-version"], { timeout: 10_000 }).then(
        (r) => r.stdout.split("\n")[0] ?? "unknown",
      ),
      execa(this.ffprobeBinary, ["-version"], { timeout: 10_000 }).then(
        (r) => r.stdout.split("\n")[0] ?? "unknown",
      ),
    ]);
    return { ffmpeg: ffmpegResult, ffprobe: ffprobeResult };
  }

  /* ── Private helpers ────────────────────────────────────────── */

  private findVideoFile(videoId: string): string | undefined {
    const assets = this.store.listAssetsForVideo(videoId);
    const video = assets.find((a) => a.kind === "video" && existsSync(a.filePath));
    return video?.filePath;
  }

  private async probeDuration(filePath: string): Promise<number | undefined> {
    try {
      const { stdout } = await execa(this.ffprobeBinary, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        filePath,
      ], { timeout: 15_000 });
      const data = JSON.parse(stdout) as { format?: { duration?: string } };
      const dur = data.format?.duration;
      return dur ? parseFloat(dur) : undefined;
    } catch {
      return undefined;
    }
  }
}
