import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { execa } from "execa";
import { commandOnPath } from "../install-diagnostics.js";
import { chunkAudioForStt, offsetTranscript, stitchTranscripts } from "./chunker.js";
import type { SttProvider, SttTranscribeOptions, SttTranscriptionResult } from "./types.js";
import type { TranscriptRecord, TranscriptSegment } from "../types.js";
import { reportProgress } from "../progress.js";

export class WhisperCppProvider implements SttProvider {
  readonly id = "whisper-cpp" as const;

  constructor(
    private readonly binary: string,
    private readonly modelPath: string,
  ) {}

  async transcribe(audioPath: string, options: SttTranscribeOptions = {}): Promise<SttTranscriptionResult> {
    const chunks = await chunkAudioForStt(audioPath);
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
  }

  private async transcribeOne(path: string, videoId: string, languageHint?: string): Promise<TranscriptRecord> {
    const args = [
      "-m", this.modelPath,
      "-f", path,
      "-oj",
      "-np",
    ];
    if (languageHint) {
      args.push("-l", languageHint);
    }
    const { stdout } = await execa(this.binary, args, { timeout: 600_000 });
    return parseWhisperJson(stdout, videoId, languageHint);
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
  const parts = value.split(":").map(Number);
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
