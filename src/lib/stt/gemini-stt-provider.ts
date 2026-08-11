import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { chunkAudioForStt, cleanupChunks, offsetTranscript, stitchTranscripts } from "./chunker.js";
import type { SttProvider, SttTranscribeOptions, SttTranscriptionResult } from "./types.js";
import type { TranscriptRecord } from "../types.js";
import { reportProgress } from "../progress.js";
import { ensureUsefulTranscriptText } from "./validation.js";
import { withRetry } from "../retry.js";

// Gemini caps an inline request at ~20 MB; base64 inflates raw bytes by ~33%, so keep
// raw audio per chunk under ~15 MB to stay within the limit after encoding.
const GEMINI_MAX_CHUNK_BYTES = 15 * 1024 * 1024;
const GEMINI_REQUEST_TIMEOUT_MS = 120_000;

export class GeminiSttProvider implements SttProvider {
  readonly id = "gemini" as const;
  private client: GoogleGenAI | undefined;

  constructor(
    private readonly apiKey: string,
    readonly model = process.env.VIDLENS_GEMINI_STT_MODEL || "gemini-2.5-flash",
  ) {}

  async transcribe(audioPath: string, options: SttTranscribeOptions = {}): Promise<SttTranscriptionResult> {
    const chunks = await chunkAudioForStt(audioPath, { maxBytes: GEMINI_MAX_CHUNK_BYTES });
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
    const client = this.client ??= new GoogleGenAI({ apiKey: this.apiKey });
    const mimeType = mimeTypeFor(path);
    const bytes = readFileSync(path).toString("base64");
    const prompt = [
      "Transcribe this audio. Return only the transcript text.",
      languageHint ? `Language hint: ${languageHint}.` : undefined,
    ].filter(Boolean).join("\n");
    const response = await client.models.generateContent({
      model: this.model,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: bytes } },
        ],
      }],
      config: {
        abortSignal: AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS),
        httpOptions: { timeout: GEMINI_REQUEST_TIMEOUT_MS },
      },
    });
    const text = ensureUsefulTranscriptText(readGeminiText(response), "Gemini");
    return {
      videoId,
      languageUsed: languageHint,
      sourceType: "generated_from_audio",
      confidence: 0.82,
      transcriptText: text,
      segments: [{ tStartSec: 0, text }],
    };
  }
}

function readGeminiText(response: unknown): string {
  if (response && typeof response === "object") {
    const candidate = response as {
      text?: string;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    if (typeof candidate.text === "string") {
      return candidate.text;
    }
    const text = candidate.candidates?.flatMap((item) => item.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join(" ");
    if (text) {
      return text;
    }
  }
  throw new Error("Gemini STT response did not include transcript text.");
}

export function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    case ".mp4":
      // STT receives the downloader's best_audio asset. Social extractors often
      // store that audio-only stream in an MP4 container, so declaring it as
      // video makes Gemini reject it with "0 Frames found".
      return "audio/mp4";
    case ".m4a":
    default:
      return "audio/mp4";
  }
}
