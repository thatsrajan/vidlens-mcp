import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { chunkAudioForStt, cleanupChunks, offsetTranscript, stitchTranscripts } from "./chunker.js";
import type { SttProvider, SttTranscribeOptions, SttTranscriptionResult } from "./types.js";
import type { TranscriptRecord, TranscriptSegment } from "../types.js";
import { reportProgress } from "../progress.js";
import { ensureUsefulTranscriptText } from "./validation.js";
import { withRetry } from "../retry.js";

// OpenAI caps the transcription upload at 26 MB; leave headroom for multipart overhead.
const OPENAI_MAX_CHUNK_BYTES = 24 * 1024 * 1024;
const OPENAI_REQUEST_TIMEOUT_MS = 120_000;

export class OpenAiWhisperProvider implements SttProvider {
  readonly id = "openai" as const;

  constructor(
    private readonly apiKey: string,
    readonly model = process.env.VIDLENS_OPENAI_STT_MODEL || "gpt-4o-transcribe",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audioPath: string, options: SttTranscribeOptions = {}): Promise<SttTranscriptionResult> {
    const chunks = await chunkAudioForStt(audioPath, { maxBytes: OPENAI_MAX_CHUNK_BYTES });
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
        const transcript = await withRetry(
          () => this.transcribeOne(chunk.path, options.videoId ?? basename(audioPath), options.languageHint),
        );
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
    const form = new FormData();
    const bytes = readFileSync(path);
    form.set("file", new Blob([bytes]), basename(path));
    form.set("model", this.model);
    // Only whisper-1 returns per-segment timestamps, and only under verbose_json; the
    // gpt-4o-transcribe models reject verbose_json, so fall back to json for them.
    form.set("response_format", this.model === "whisper-1" ? "verbose_json" : "json");
    if (languageHint) {
      form.set("language", languageHint);
    }

    const response = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(`OpenAI transcription failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`) as Error & { status: number };
      // Surface the HTTP status so withRetry's default policy can retry 429/5xx.
      error.status = response.status;
      throw error;
    }
    const data = await response.json() as {
      text?: string;
      language?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };
    const segments: TranscriptSegment[] = Array.isArray(data.segments) && data.segments.length > 0
      ? data.segments.map((segment, index) => ({
        tStartSec: Number(segment.start ?? index),
        tEndSec: segment.end === undefined ? undefined : Number(segment.end),
        text: segment.text ?? "",
      })).filter((segment) => segment.text.trim())
      : [];
    const text = ensureUsefulTranscriptText(data.text ?? segments.map((segment) => segment.text).join(" "), "OpenAI");
    return {
      videoId,
      languageUsed: data.language ?? languageHint,
      sourceType: "generated_from_audio",
      confidence: 0.86,
      transcriptText: text,
      segments: segments.length > 0 ? segments : [{ tStartSec: 0, text }],
    };
  }
}
