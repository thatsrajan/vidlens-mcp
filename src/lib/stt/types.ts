import type { SttProviderId, TranscriptRecord } from "../types.js";
import type { ProgressReporter } from "../progress.js";

export interface SttProvider {
  readonly id: SttProviderId;
  readonly model?: string;
  transcribe(audioPath: string, options?: SttTranscribeOptions): Promise<SttTranscriptionResult>;
}

export interface SttTranscribeOptions {
  videoId?: string;
  languageHint?: string;
  progressReporter?: ProgressReporter;
}

export interface SttTranscriptionResult {
  transcript: TranscriptRecord;
  chunksProcessed: number;
  totalChunks: number;
}
