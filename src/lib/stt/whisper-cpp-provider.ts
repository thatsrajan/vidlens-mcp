import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { commandOnPath } from "../install-diagnostics.js";
import { chunkAudioForStt, cleanupChunks, offsetTranscript, stitchTranscripts } from "./chunker.js";
import type { SttProvider, SttTranscribeOptions, SttTranscriptionResult } from "./types.js";
import type { TranscriptRecord, TranscriptSegment } from "../types.js";
import { reportProgress } from "../progress.js";

export class WhisperCppProvider implements SttProvider {
  readonly id = "whisper-cpp" as const;

  constructor(
    private readonly binary: string,
    private readonly modelPath: string,
    private readonly ffmpegBinary = "ffmpeg",
  ) {}

  async transcribe(audioPath: string, options: SttTranscribeOptions = {}): Promise<SttTranscriptionResult> {
    const chunks = await chunkAudioForStt(audioPath);
    try {
      const transcripts: TranscriptRecord[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        await reportProgress(options.progressReporter, {
          phase: "stt",
          current: index,
          total: chunks.length,
          message: `Transcribing chunk ${index + 1}/${chunks.length}`,
        });
        const transcript = await this.transcribeOne(chunk.path, options.videoId ?? basename(audioPath), options.languageHint);
        transcripts.push(offsetTranscript(transcript, chunk.startSec));
      }
      await reportProgress(options.progressReporter, {
        phase: "stt",
        current: chunks.length,
        total: chunks.length,
        message: "Transcription complete",
      });
      return {
        transcript: stitchTranscripts(options.videoId ?? basename(audioPath), transcripts),
        chunksProcessed: chunks.length,
        totalChunks: chunks.length,
      };
    } finally {
      cleanupChunks(chunks, audioPath);
    }
  }

  private async transcribeOne(path: string, videoId: string, languageHint?: string): Promise<TranscriptRecord> {
    // whisper-cli only accepts flac/mp3/ogg/wav, but the pipeline feeds m4a; convert
    // each chunk to 16 kHz mono WAV first. `-of <base> -oj` writes JSON to `<base>.json`
    // (stdout is bracketed human text, not JSON), so read the sidecar and clean both up.
    const base = join(tmpdir(), `vidlens-whisper-${randomUUID()}`);
    const wavPath = `${base}.wav`;
    const jsonPath = `${base}.json`;
    try {
      await execa(this.ffmpegBinary, [
        "-y",
        "-i", path,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        wavPath,
      ], { timeout: 120_000 });
      const args = [
        "-m", this.modelPath,
        "-f", wavPath,
        "-oj",
        "-of", base,
        "-np",
      ];
      if (languageHint) {
        args.push("-l", languageHint);
      }
      await execa(this.binary, args, { timeout: 600_000 });
      return parseWhisperJsonFile(jsonPath, videoId, languageHint);
    } finally {
      rmSync(wavPath, { force: true });
      rmSync(jsonPath, { force: true });
    }
  }
}

export function resolveWhisperCppProvider(env: NodeJS.ProcessEnv = process.env): WhisperCppProvider | null {
  const modelPath = env.VIDLENS_WHISPER_MODEL_PATH;
  if (!modelPath || !existsSync(modelPath)) {
    return null;
  }
  const binary = commandOnPath("whisper-cli", env, process.platform) ?? commandOnPath("whisper.cpp", env, process.platform);
  return binary ? new WhisperCppProvider(binary, modelPath) : null;
}

export function parseWhisperJson(input: string, videoId: string, languageHint?: string): TranscriptRecord {
  const parsed = JSON.parse(input || "{}") as {
    transcription?: Array<{ timestamps?: { from?: string; to?: string }; text?: string }>;
    result?: { language?: string };
  };
  const segments: TranscriptSegment[] = (parsed.transcription ?? [])
    .map((item, index) => ({
      tStartSec: parseTimestamp(item.timestamps?.from) ?? index,
      tEndSec: parseTimestamp(item.timestamps?.to),
      text: item.text?.trim() ?? "",
    }))
    .filter((segment) => segment.text);
  return {
    videoId,
    languageUsed: parsed.result?.language ?? languageHint,
    sourceType: "generated_from_audio",
    confidence: 0.78,
    transcriptText: segments.map((segment) => segment.text).join(" "),
    segments,
  };
}

export function parseWhisperJsonFile(path: string, videoId: string, languageHint?: string): TranscriptRecord {
  return parseWhisperJson(readFileSync(path, "utf8"), videoId, languageHint);
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  // whisper emits SRT-style comma milliseconds ("00:00:00,000"); normalize to a dot
  // so Number() can parse the seconds component instead of yielding NaN.
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }
  return parts[0];
}
