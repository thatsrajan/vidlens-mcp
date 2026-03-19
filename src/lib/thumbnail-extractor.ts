/**
 * Thumbnail / Keyframe Extractor — uses ffmpeg to extract frames from downloaded videos.
 *
 * Honest boundaries:
 * - Extracts keyframes at specified intervals or I-frame positions
 * - Does NOT do visual search, visual embeddings, or frame classification
 * - Provides raw frame files that can be used by external vision models
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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

    const videoProbe = await this.probeVideo(videoPath);
    const durationSec = videoProbe.durationSec;
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

    // Pre-fetch existing assets once for skip checks (avoids N DB queries)
    const existingByPath = new Map(
      this.store.listAssetsForVideo(options.videoId).map((a) => [a.filePath, a]),
    );

    const plannedOutputs = timestamps.map((_, index) =>
      join(framesDir, `${options.videoId}_${String(index + 1).padStart(4, "0")}.${imageFormat}`),
    );
    const existingAssets = plannedOutputs.map((filePath) =>
      existsSync(filePath) ? (existingByPath.get(filePath) ?? null) : null,
    );

    if (existingAssets.every((asset): asset is MediaAsset => asset !== null)) {
      return {
        videoId: options.videoId,
        framesExtracted: existingAssets.length,
        assets: existingAssets,
        durationMs: Date.now() - startMs,
      };
    }

    const hasPartialExistingAssets = existingAssets.some((asset) => asset !== null);
    const derivedDimensions = deriveOutputDimensions(videoProbe.width, videoProbe.height, width);

    let assets: MediaAsset[];
    if (hasPartialExistingAssets) {
      assets = await this.extractFramesIndividually({
        videoId: options.videoId,
        videoPath,
        timestamps,
        plannedOutputs,
        width,
        existingByPath,
      });
    } else {
      try {
        await this.extractFramesSinglePass(videoPath, framesDir, options.videoId, imageFormat, intervalSec, width);
        assets = this.registerExtractedFrames({
          videoId: options.videoId,
          timestamps,
          plannedOutputs,
          existingByPath,
          frameWidth: derivedDimensions?.width,
          frameHeight: derivedDimensions?.height,
        });
      } catch {
        assets = await this.extractFramesIndividually({
          videoId: options.videoId,
          videoPath,
          timestamps,
          plannedOutputs,
          width,
          existingByPath,
        });
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

  private async probeVideo(filePath: string): Promise<{
    durationSec?: number;
    width?: number;
    height?: number;
  }> {
    try {
      const { stdout } = await execa(this.ffprobeBinary, [
        "-v", "error",
        "-show_entries", "format=duration:stream=width,height",
        "-of", "json",
        filePath,
      ], { timeout: 15_000 });
      const data = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<{ width?: number; height?: number }>;
      };
      const dur = data.format?.duration;
      return {
        durationSec: dur ? parseFloat(dur) : undefined,
        width: data.streams?.[0]?.width,
        height: data.streams?.[0]?.height,
      };
    } catch {
      return {};
    }
  }

  private async extractFramesSinglePass(
    videoPath: string,
    framesDir: string,
    videoId: string,
    imageFormat: "jpg" | "png" | "webp",
    intervalSec: number,
    width: number,
  ): Promise<void> {
    const outputPattern = join(framesDir, `${videoId}_%04d.${imageFormat}`);
    await execa(this.ffmpegBinary, [
      "-i", videoPath,
      "-vf", `fps=1/${intervalSec},scale=${width}:-1`,
      "-q:v", "2",
      "-vsync", "vfr",
      "-y",
      outputPattern,
    ], { timeout: 120_000, reject: true });
  }

  private async extractFramesIndividually(params: {
    videoId: string;
    videoPath: string;
    timestamps: number[];
    plannedOutputs: string[];
    width: number;
    existingByPath: Map<string, MediaAsset>;
  }): Promise<MediaAsset[]> {
    const CONCURRENCY = 4;

    const results = await poolMap(
      params.timestamps,
      async (timestamp, index) => {
        const outFile = params.plannedOutputs[index];
        if (existsSync(outFile)) {
          const existing = params.existingByPath.get(outFile);
          if (existing) return existing;
        }

        try {
          await execa(this.ffmpegBinary, [
            "-ss", String(timestamp),
            "-i", params.videoPath,
            "-vframes", "1",
            "-vf", `scale=${params.width}:-1`,
            "-q:v", "2",
            "-y",
            outFile,
          ], { timeout: 30_000, reject: true });

          if (!existsSync(outFile)) {
            return null;
          }

          const frameProbe = await this.probeVideo(outFile);
          return this.store.registerAsset({
            videoId: params.videoId,
            kind: "keyframe",
            filePath: outFile,
            timestampSec: timestamp,
            width: frameProbe.width,
            height: frameProbe.height,
          });
        } catch {
          return null;
        }
      },
      CONCURRENCY,
    );

    return results.filter((asset): asset is MediaAsset => asset !== null);
  }

  private registerExtractedFrames(params: {
    videoId: string;
    timestamps: number[];
    plannedOutputs: string[];
    existingByPath: Map<string, MediaAsset>;
    frameWidth?: number;
    frameHeight?: number;
  }): MediaAsset[] {
    const extractedFiles = new Set(
      params.plannedOutputs.filter((filePath) => existsSync(filePath)),
    );
    if (extractedFiles.size === 0) {
      const filesOnDisk = new Set(
        readdirSync(join(this.store.videoDir(params.videoId), "keyframes"))
          .filter((name) => name.startsWith(`${params.videoId}_`))
          .map((name) => join(this.store.videoDir(params.videoId), "keyframes", name)),
      );
      for (const filePath of params.plannedOutputs) {
        if (filesOnDisk.has(filePath)) {
          extractedFiles.add(filePath);
        }
      }
    }

    const assets: MediaAsset[] = [];
    params.plannedOutputs.forEach((filePath, index) => {
      if (!extractedFiles.has(filePath)) {
        return;
      }
      const existing = params.existingByPath.get(filePath);
      if (existing) {
        assets.push(existing);
        return;
      }
      assets.push(this.store.registerAsset({
        videoId: params.videoId,
        kind: "keyframe",
        filePath,
        timestampSec: params.timestamps[index],
        width: params.frameWidth,
        height: params.frameHeight,
      }));
    });
    return assets;
  }
}

function deriveOutputDimensions(sourceWidth: number | undefined, sourceHeight: number | undefined, requestedWidth: number): {
  width: number;
  height: number;
} | null {
  if (!sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }
  const width = Math.min(requestedWidth, sourceWidth);
  const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
  return { width, height };
}

/** Run `fn` over `items` with at most `concurrency` in-flight at once, preserving order. */
async function poolMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
