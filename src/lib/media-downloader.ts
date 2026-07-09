/**
 * Media Downloader — yt-dlp wrapper for downloading video/audio/thumbnail files.
 *
 * Downloads go to the MediaStore's asset directory, then get registered in the manifest.
 * This module intentionally does NOT do frame-level visual indexing — it downloads
 * and stores media files. Visual search is handled separately by the visual-search layer.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { execa } from "execa";
import { MediaStore, type AssetKind, type MediaAsset } from "./media-store.js";
import { resolveVideoSource, type VideoSourceRef } from "./video-source.js";
import { CookieStore } from "./auth/cookie-store.js";
import { redactError } from "./redactor.js";
import { assertPublicHttpUrl } from "./url-guard.js";

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
  /** True when the asset was served from an existing local file (no download performed). */
  cached: boolean;
}

/* ── Downloader ────────────────────────────────────────────────── */

export class MediaDownloader {
  constructor(
    private readonly store: MediaStore,
    private readonly ytdlpBinary = "yt-dlp",
    private readonly cookieStore = new CookieStore(),
    private readonly ffprobeBinary = "ffprobe",
  ) {}

  /**
   * In-flight downloads keyed by `${videoId}::${format}`. Concurrent requests
   * for the same asset (e.g. transcription and visual indexing both triggering
   * best_audio) share one promise instead of racing: without this, both would
   * miss the cache, both would clean the output path, and yt-dlp could write
   * the same final file twice concurrently.
   */
  private readonly inflight = new Map<string, Promise<DownloadResult>>();

  /**
 * Download or ingest a media asset and register it in the manifest.
   */
  async download(options: DownloadOptions): Promise<DownloadResult> {
    const source = resolveVideoSource(options.videoIdOrUrl);
    const key = `${source.assetKey}::${options.format}`;
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const task = this.performDownload(source, options).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  private async performDownload(source: VideoSourceRef, options: DownloadOptions): Promise<DownloadResult> {
    const videoId = source.assetKey;
    const url = source.localPath ?? source.canonicalUrl;
    const outDir = options.outputDir ?? this.store.videoDir(videoId);
    const maxSizeMb = clampMaxSizeMb(options.maxSizeMb);
    const startMs = Date.now();

    // SSRF guard: any non-local URL is about to be handed to yt-dlp.
    if (source.platform !== "local_file") {
      assertPublicHttpUrl(url);
    }

    // Purge unreadable/dead rows before consulting the cache. This also covers
    // legacy rows with no recorded format, which the format match below never
    // inspects but visual/keyframe consumers would still pick up by kind.
    const existing = await this.sweepUnreadableAssets(videoId);

    // Check if we already have this exact format for this video. Kind alone is
    // ambiguous for video (best_video and worst_video share kind "video"), so
    // match on the recorded format too.
    const alreadyHave = existing.find(
      (a) => existsSync(a.filePath) && assetMatchesFormat(a, options.format),
    );
    if (alreadyHave) {
      return {
        asset: alreadyHave,
        downloadedBytes: 0,
        durationMs: Date.now() - startMs,
        cached: true,
      };
    }

    if (source.platform === "local_file") {
      return this.ingestLocalFile(source, options.format, outDir, maxSizeMb, startMs);
    }

    if (options.format === "thumbnail") {
      return this.downloadThumbnail(source, url, outDir, startMs);
    }

    const kind = formatToKind(options.format);

    // Build yt-dlp args. The basename is scoped to the requested format so no
    // two formats can ever resolve to the same path: on X/TikTok the audio-only
    // rendition is an fMP4 whose extension is also .mp4, and a bare
    // `${videoId}.%(ext)s` template made yt-dlp resume-append the audio stream
    // onto an already-complete video file, corrupting both.
    const formatArg = ytdlpFormatArg(options.format);
    const outputBase = `${videoId}.${options.format}`;
    const outputTemplate = join(outDir, `${outputBase}.%(ext)s`);

    // Delete unregistered leftovers from a previous failed attempt. Anything
    // matching this template that were healthy would have been a cache hit
    // above; leaving stale bytes here would let yt-dlp resume into them.
    removeMatchingFiles(outDir, outputBase);

    const args = [
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      ...this.ytDlpAuthArgs(source),
      ...extractorArgsForPlatform(source.platform),
      "-f", formatArg,
      "--max-filesize", `${maxSizeMb}M`,
      "-o", outputTemplate,
      url,
    ];

    try {
      await execa(this.ytdlpBinary, args, { timeout: 300_000, reject: true });
    } catch (error) {
      const message = redactError(error);
      throw new Error(`yt-dlp download failed for ${videoId}: ${message}`);
    }

    // Find the downloaded file
    const downloadedFile = findDownloadedFile(outDir, outputBase);
    if (!downloadedFile) {
      throw new Error(`Download appeared to succeed but no file found in ${outDir} for ${videoId}`);
    }

    const filePath = join(outDir, downloadedFile);
    const stat = statSync(filePath);

    // Reject unreadable files before they enter the manifest — a corrupt asset
    // poisons every downstream consumer (keyframes, STT, duration) with errors
    // that no longer mention the file.
    const probe = await this.probeMediaFile(filePath);
    if (!probe.ok) {
      rmSync(filePath, { force: true });
      throw new Error(
        `Downloaded file for ${videoId} (${options.format}) is not readable by ffprobe: ${probe.reason}. ` +
        `The corrupt file was deleted; retry the download.`,
      );
    }

    // Get duration from yt-dlp metadata
    let durationSec: number | undefined = probe.durationSec;
    let metadata: Record<string, unknown> | undefined;
    try {
      const { stdout } = await execa(this.ytdlpBinary, [
        "--dump-single-json", "--skip-download", "--no-warnings",
        ...this.ytDlpAuthArgs(source),
        ...extractorArgsForPlatform(source.platform),
        url,
      ], { timeout: 30_000 });
      const meta = JSON.parse(stdout) as { duration?: number; title?: string; extractor?: string; webpage_url?: string };
      // The probed duration of the actual file wins; metadata fills the gap
      // when ffprobe is unavailable.
      durationSec ??= meta.duration;
      metadata = compactMeta({
        title: meta.title,
        extractor: meta.extractor,
        webpageUrl: meta.webpage_url,
        sourceInput: options.videoIdOrUrl,
        format: options.format,
      });
    } catch {
      // Metadata dump is non-critical, but still record the requested format so
      // dedupe can distinguish best_video from worst_video on the next call.
      metadata = { format: options.format };
    }

    const asset = this.store.registerAsset({
      videoId,
      sourcePlatform: source.platform,
      sourceUrl: source.sourceUrl,
      sourceId: source.sourceId,
      canonicalUrl: source.canonicalUrl,
      kind,
      filePath,
      durationSec,
      meta: metadata,
    });

    return {
      asset,
      downloadedBytes: stat.size,
      durationMs: Date.now() - startMs,
      cached: false,
    };
  }

  /**
   * Download the YouTube thumbnail image for a video.
   */
  private async downloadThumbnail(
    source: VideoSourceRef,
    url: string,
    outDir: string,
    startMs: number,
  ): Promise<DownloadResult> {
    const videoId = source.assetKey;
    const outputTemplate = join(outDir, `${videoId}-thumb.%(ext)s`);

    const args = [
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "--write-thumbnail",
      "--convert-thumbnails", "jpg",
      ...this.ytDlpAuthArgs(source),
      ...extractorArgsForPlatform(source.platform),
      "-o", outputTemplate,
      url,
    ];

    try {
      await execa(this.ytdlpBinary, args, { timeout: 60_000, reject: true });
    } catch (error) {
      const message = redactError(error);
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
      sourcePlatform: source.platform,
      sourceUrl: source.sourceUrl,
      sourceId: source.sourceId,
      canonicalUrl: source.canonicalUrl,
      kind: "thumbnail",
      filePath,
      width,
      height,
    });

    return {
      asset,
      downloadedBytes: stat.size,
      durationMs: Date.now() - startMs,
      cached: false,
    };
  }

  private async ingestLocalFile(
    source: VideoSourceRef,
    format: DownloadFormat,
    outDir: string,
    maxSizeMb: number,
    startMs: number,
  ): Promise<DownloadResult> {
    if (!source.localPath) {
      throw new Error("Local file source did not include a file path.");
    }
    if (format === "best_audio") {
      return this.extractLocalAudio(source, outDir, maxSizeMb, startMs);
    }
    if (format === "thumbnail") {
      throw new Error("Local files currently support video or audio ingestion only. Use best_video, worst_video, or best_audio.");
    }
    if (format !== "best_video" && format !== "worst_video") {
      throw new Error("Local files currently support video or audio ingestion only. Use best_video, worst_video, or best_audio.");
    }

    const stat = statSync(source.localPath);
    const maxBytes = maxSizeMb * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw new Error(`Local file exceeds maxSizeMb (${maxSizeMb} MB): ${source.localPath}`);
    }

    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, basename(source.localPath));
    // When outDir points at the source's own directory, outFile IS the user's
    // original — it must never be deleted, only validated.
    const isSourceItself = resolve(outFile) === resolve(source.localPath);

    // A stale target from an earlier run may be corrupt; replace it with a
    // fresh copy of the source instead of failing until a manual cleanup.
    if (!isSourceItself && existsSync(outFile) && !(await this.probeMediaFile(outFile)).ok) {
      rmSync(outFile, { force: true });
    }
    if (!existsSync(outFile)) {
      copyFileSync(source.localPath, outFile);
    }

    const probe = await this.probeMediaFile(outFile);
    if (!probe.ok) {
      if (!isSourceItself) {
        rmSync(outFile, { force: true });
      }
      throw new Error(
        `Local file ${source.localPath} is not readable by ffprobe: ${probe.reason}. ` +
        `It was not ingested — confirm the file plays before retrying.`,
      );
    }

    const asset = this.store.registerAsset({
      videoId: source.assetKey,
      sourcePlatform: source.platform,
      sourceUrl: source.canonicalUrl,
      sourceId: source.sourceId,
      canonicalUrl: source.canonicalUrl,
      kind: "video",
      filePath: outFile,
      durationSec: probe.durationSec,
      meta: compactMeta({
        sourceInput: source.input,
        originalPath: source.localPath,
        title: source.titleHint,
        format,
      }),
    });

    return {
      asset,
      downloadedBytes: existsSync(outFile) && outFile !== source.localPath ? statSync(outFile).size : 0,
      durationMs: Date.now() - startMs,
      cached: false,
    };
  }

  private async extractLocalAudio(
    source: VideoSourceRef,
    outDir: string,
    maxSizeMb: number,
    startMs: number,
  ): Promise<DownloadResult> {
    if (!source.localPath) {
      throw new Error("Local file source did not include a file path.");
    }

    const inputStat = statSync(source.localPath);
    const maxBytes = maxSizeMb * 1024 * 1024;
    if (inputStat.size > maxBytes) {
      throw new Error(`Local file exceeds maxSizeMb (${maxSizeMb} MB): ${source.localPath}`);
    }

    mkdirSync(outDir, { recursive: true });
    const base = basename(source.localPath, extname(source.localPath)).replace(/[^a-z0-9_-]+/gi, "_");
    const outFile = join(outDir, `${base}.m4a`);
    // A sanitized name can still collide with the source itself (e.g. ingesting
    // "audio.m4a" with outDir pointing at its own directory) — never delete or
    // overwrite the user's original.
    const isSourceItself = resolve(outFile) === resolve(source.localPath);

    // A stale extraction from an earlier run may be corrupt; drop it and
    // re-extract instead of failing until a manual cleanup.
    if (!isSourceItself && existsSync(outFile) && !(await this.probeMediaFile(outFile)).ok) {
      rmSync(outFile, { force: true });
    }
    if (!existsSync(outFile)) {
      try {
        await execa("ffmpeg", [
          "-y",
          "-i", source.localPath,
          "-vn",
          "-c:a", "aac",
          "-b:a", "192k",
          outFile,
        ], { timeout: 300_000, reject: true });
      } catch (error) {
        throw new Error(`Local audio extraction failed for ${source.assetKey}: ${redactError(error)}`);
      }
    }

    const stat = statSync(outFile);
    const probe = await this.probeMediaFile(outFile);
    if (!probe.ok) {
      if (!isSourceItself) {
        rmSync(outFile, { force: true });
      }
      throw new Error(
        `Extracted audio for ${source.assetKey} is not readable by ffprobe: ${probe.reason}. ` +
        `Confirm the source file plays, then retry the extraction.`,
      );
    }

    const asset = this.store.registerAsset({
      videoId: source.assetKey,
      sourcePlatform: source.platform,
      sourceUrl: source.canonicalUrl,
      sourceId: source.sourceId,
      canonicalUrl: source.canonicalUrl,
      kind: "audio",
      filePath: outFile,
      durationSec: probe.durationSec,
      meta: compactMeta({
        sourceInput: source.input,
        originalPath: source.localPath,
        title: source.titleHint,
        format: "best_audio",
      }),
    });

    return {
      asset,
      downloadedBytes: stat.size,
      durationMs: Date.now() - startMs,
      cached: false,
    };
  }

  /**
   * Validate every registered video/audio file for a video and purge rows whose
   * file is missing or unreadable by ffprobe — all rows sharing a path go
   * together, since pre-format-scoped stores could register a video and an
   * audio asset against one (corrupted) file. Returns the surviving assets.
   * Public because visual indexing and keyframe extraction pick assets by kind
   * straight from the manifest; they call this first so a corrupt legacy file
   * is never handed to ffmpeg.
   */
  async sweepUnreadableAssets(videoId: string): Promise<MediaAsset[]> {
    const assets = this.store.listAssetsForVideo(videoId);
    const checkedPaths = new Set<string>();
    let purged = false;
    for (const asset of assets) {
      if (asset.kind !== "video" && asset.kind !== "audio") continue;
      if (checkedPaths.has(asset.filePath)) continue;
      checkedPaths.add(asset.filePath);
      const readable = existsSync(asset.filePath) && (await this.probeMediaFile(asset.filePath)).ok;
      if (!readable) {
        this.store.removeAssetsByFilePath(asset.filePath, true);
        purged = true;
      }
    }
    return purged ? this.store.listAssetsForVideo(videoId) : assets;
  }

  /**
   * Validate that ffprobe can parse a media file, returning its duration when
   * available. A missing ffprobe binary skips validation (`ok: true` with no
   * duration) — when we have no way to check, the download is trusted rather
   * than rejected.
   */
  private async probeMediaFile(
    filePath: string,
  ): Promise<{ ok: true; durationSec?: number } | { ok: false; reason: string }> {
    try {
      const { stdout } = await execa(this.ffprobeBinary, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        filePath,
      ], { timeout: 15_000 });
      const data = JSON.parse(stdout) as { format?: { duration?: string } };
      const duration = Number(data.format?.duration);
      return { ok: true, durationSec: Number.isFinite(duration) && duration >= 0 ? duration : undefined };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true };
      }
      const stderr = (error as { stderr?: string }).stderr?.trim();
      return { ok: false, reason: stderr ? stderr.split("\n").at(-1) ?? stderr : redactError(error) };
    }
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

  private ytDlpAuthArgs(source: VideoSourceRef): string[] {
    return this.cookieStore.argsFor(source.platform);
  }
}

/* ── Helpers ───────────────────────────────────────────────────── */

/** Clamp maxSizeMb to a sane [1, 5000] range and reject non-finite values (Infinity/NaN). */
function clampMaxSizeMb(value: number | undefined): number {
  if (value === undefined) return 500;
  if (!Number.isFinite(value)) {
    throw new Error(`maxSizeMb must be a finite number (got ${value}).`);
  }
  return Math.min(5000, Math.max(1, value));
}

/**
 * Whether an existing asset satisfies a requested format. Audio/thumbnail kinds
 * map 1:1 from format so kind equality is enough; the "video" kind is produced
 * by both best_video and worst_video, so the recorded format must match to avoid
 * returning a low-quality file when the caller asked for the best (or vice-versa).
 */
function assetMatchesFormat(asset: MediaAsset, format: DownloadFormat): boolean {
  const kind = formatToKind(format);
  if (asset.kind !== kind) return false;
  if (kind !== "video") return true;
  const recorded = typeof asset.meta?.format === "string" ? asset.meta.format : undefined;
  return recorded === format;
}

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

function extractorArgsForPlatform(platform: VideoSourceRef["platform"]): string[] {
  switch (platform) {
    case "tiktok":
      return ["--extractor-args", "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com"];
    case "instagram":
      return ["--extractor-args", "instagram:include_stories=false"];
    case "x":
      return ["--extractor-args", "twitter:legacy_api=false"];
    default:
      return [];
  }
}

function findDownloadedFile(dir: string, outputBase: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir);
  // Regular files only: sidecar directories share the prefix (STT chunking
  // creates `<audio>.chunks/` next to the audio file) and must never be
  // registered as the downloaded asset.
  const isUsable = (f: string) =>
    !f.endsWith(".part") && !f.startsWith(".") && statSync(join(dir, f)).isFile();
  // Only accept a file that belongs to this download's format-scoped output
  // template (`${videoId}.${format}.<ext>`). Never fall back to "newest usable
  // file" — that can register an unrelated download left in the directory. The
  // caller raises a clear error when nothing matches.
  return files.find((f) => f.startsWith(`${outputBase}.`) && isUsable(f));
}

/**
 * Delete stale output matching a download's template: partial files from a
 * failed attempt, plus prefix-sharing sidecars like `<audio>.chunks/` dirs
 * left behind by a crashed transcription (hence recursive).
 */
function removeMatchingFiles(dir: string, outputBase: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${outputBase}.`)) {
      rmSync(join(dir, f), { recursive: true, force: true });
    }
  }
}

function findFile(dir: string, prefix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).find((f) => f.startsWith(prefix));
}

function compactMeta(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
