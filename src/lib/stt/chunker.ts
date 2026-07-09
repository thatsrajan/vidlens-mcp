import { mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { execa } from "execa";

export interface AudioChunk {
  path: string;
  startSec: number;
  durationSec?: number;
}

export interface ChunkAudioOptions {
  maxBytes?: number;
  chunkDurationSec?: number;
  outputDir?: string;
  ffmpegBinary?: string;
  ffprobeBinary?: string;
}

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Chunk duration (seconds) that keeps each chunk under `maxBytes`, derived from the
 * file's measured byte-rate. The 0.9 factor leaves headroom for encoder overhead and
 * downstream base64 expansion. An explicit cap only lowers the result, never raises it.
 */
export function deriveChunkDurationSec(
  sizeBytes: number,
  durationSec: number,
  maxBytes: number,
  explicitCapSec?: number,
): number {
  const bytesPerSec = sizeBytes / durationSec;
  const derived = Math.max(1, Math.floor((maxBytes * 0.9) / bytesPerSec));
  return explicitCapSec ? Math.min(explicitCapSec, derived) : derived;
}

export async function chunkAudioForStt(audioPath: string, options: ChunkAudioOptions = {}): Promise<AudioChunk[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stat = statSync(audioPath);
  const durationSec = await probeDuration(audioPath, options.ffprobeBinary ?? "ffprobe");
  // Anything already under the cap is fine as a single chunk regardless of duration.
  if (stat.size <= maxBytes) {
    return [{ path: audioPath, startSec: 0, durationSec }];
  }
  // Over the cap but we can't measure duration — nothing to base chunk
  // boundaries on. Passing the oversized file through would just make the
  // provider reject it with an opaque API error, so fail here with the cause.
  if (!durationSec || durationSec <= 0) {
    const sizeMb = Math.round(stat.size / (1024 * 1024));
    const capMb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(
      `Audio file is ${sizeMb} MB (provider limit ${capMb} MB per request) and ffprobe could not ` +
      `measure its duration to split it into chunks. The file may be corrupt or ffprobe may be ` +
      `missing — verify the file plays, or remove the asset and re-download it, then retry.`,
    );
  }

  const chunkDurationSec = deriveChunkDurationSec(stat.size, durationSec, maxBytes, options.chunkDurationSec);
  const outputDir = options.outputDir ?? join(audioPath + ".chunks");
  mkdirSync(outputDir, { recursive: true });
  const ext = extname(audioPath) || ".m4a";
  const base = basename(audioPath, ext).replace(/[^a-z0-9_-]+/gi, "_");
  const chunks: AudioChunk[] = [];

  for (let startSec = 0, index = 0; startSec < durationSec; startSec += chunkDurationSec, index += 1) {
    const outPath = join(outputDir, `${base}-chunk-${String(index + 1).padStart(3, "0")}${ext}`);
    const remaining = Math.max(0, durationSec - startSec);
    const chunkLength = Math.min(chunkDurationSec, remaining);
    await execa(options.ffmpegBinary ?? "ffmpeg", [
      "-y",
      "-ss", String(startSec),
      "-t", String(chunkLength),
      "-i", audioPath,
      "-vn",
      "-c", "copy",
      outPath,
    ], { timeout: 120_000 });
    chunks.push({ path: outPath, startSec, durationSec: chunkLength });
  }

  return chunks;
}

/**
 * Remove any temp chunk directories created by {@link chunkAudioForStt}. Passthrough
 * chunks reuse the original path (same dir as the source file) and are left untouched;
 * only generated chunks live under `<audio>.chunks/`, so only those dirs are removed.
 * Callers should invoke this in a finally block once transcription of the chunks is done.
 */
export function cleanupChunks(chunks: AudioChunk[], originalPath: string): void {
  const dirs = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.path !== originalPath) {
      dirs.add(dirname(chunk.path));
    }
  }
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a leftover temp dir must not fail transcription.
    }
  }
}

export async function probeDuration(path: string, ffprobeBinary = "ffprobe"): Promise<number | undefined> {
  try {
    const { stdout } = await execa(ffprobeBinary, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "json",
      path,
    ], { timeout: 15_000 });
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

export function offsetTranscript(
  transcript: import("../types.js").TranscriptRecord,
  offsetSec: number,
): import("../types.js").TranscriptRecord {
  if (offsetSec === 0) {
    return transcript;
  }
  return {
    ...transcript,
    segments: transcript.segments.map((segment) => ({
      ...segment,
      tStartSec: segment.tStartSec + offsetSec,
      tEndSec: segment.tEndSec === undefined ? undefined : segment.tEndSec + offsetSec,
    })),
  };
}

export function stitchTranscripts(
  videoId: string,
  transcripts: import("../types.js").TranscriptRecord[],
): import("../types.js").TranscriptRecord {
  const segments = transcripts.flatMap((item) => item.segments).sort((a, b) => a.tStartSec - b.tStartSec);
  return {
    videoId,
    languageUsed: transcripts.find((item) => item.languageUsed)?.languageUsed,
    sourceType: "generated_from_audio",
    confidence: average(transcripts.map((item) => item.confidence).filter((value): value is number => value !== undefined)),
    transcriptText: transcripts.map((item) => item.transcriptText).join(" ").replace(/\s+/g, " ").trim(),
    segments,
  };
}

function average(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
