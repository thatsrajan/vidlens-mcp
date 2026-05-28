import { mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
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

export async function chunkAudioForStt(audioPath: string, options: ChunkAudioOptions = {}): Promise<AudioChunk[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stat = statSync(audioPath);
  const durationSec = await probeDuration(audioPath, options.ffprobeBinary ?? "ffprobe");
  if (stat.size <= maxBytes || !durationSec || durationSec <= (options.chunkDurationSec ?? 300)) {
    return [{ path: audioPath, startSec: 0, durationSec }];
  }

  const chunkDurationSec = options.chunkDurationSec ?? 300;
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
