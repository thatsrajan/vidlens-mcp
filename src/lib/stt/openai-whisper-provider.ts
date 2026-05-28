import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { chunkAudioForStt, offsetTranscript, stitchTranscripts } from "./chunker.js";
import type { SttProvider, SttTranscribeOptions, SttTranscriptionResult } from "./types.js";
import type { TranscriptRecord, TranscriptSegment } from "../types.js";
import { reportProgress } from "../progress.js";
import { ensureUsefulTranscriptText } from "./validation.js";

export class OpenAiWhisperProvider implements SttProvider {
  readonly id = "openai" as const;

  constructor(
    private readonly apiKey: string,
    readonly model = process.env.VIDLENS_OPENAI_STT_MODEL || "gpt-4o-transcribe",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audioPath: string, options: SttTranscribeOptions = {}): Promise<SttTranscriptionResult> {
    const chunks = await chunkAudioForStt(audioPath, { maxBytes: 24 * 1024 * 1024 });
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
    const form = new FormData();
    const bytes = readFileSync(path);
    form.set("file", new Blob([bytes]), basename(path));
    form.set("model", this.model);
    form.set("response_format", "json");
    if (languageHint) {
      form.set("language", languageHint);
    }

    const response = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI transcription failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
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
