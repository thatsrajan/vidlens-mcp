import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { withRetry, isRetryableError } from "./retry.js";

export interface FrameDescriptionInput {
  framePath: string;
  videoId: string;
  timestampSec: number;
}

export interface FrameDescriptionResult {
  framePath: string;
  description?: string;
  /** True when the Gemini call failed (quota/auth/transient) after retries — not merely "no text". */
  failed?: boolean;
}

export interface FrameDescriptionBatch {
  results: FrameDescriptionResult[];
  /** Count of frames whose description call failed after retries. */
  failures: number;
}

const DEFAULT_GEMINI_VISION_MODEL = process.env.VIDLENS_GEMINI_VISION_MODEL || "gemini-2.5-flash";

export class GeminiVisualDescriber {
  private readonly client: GoogleGenAI | null;
  readonly model: string;

  constructor(apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, model = DEFAULT_GEMINI_VISION_MODEL) {
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    this.model = model;
  }

  get available(): boolean {
    return Boolean(this.client);
  }

  async describeFrames(inputs: FrameDescriptionInput[]): Promise<FrameDescriptionBatch> {
    if (!this.client || inputs.length === 0) {
      return { results: inputs.map((input) => ({ framePath: input.framePath })), failures: 0 };
    }

    const results: FrameDescriptionResult[] = [];
    for (const batch of chunk(inputs, 5)) {
      const batchResults = await Promise.all(batch.map((input) => this.describeFrame(input)));
      results.push(...batchResults);
    }
    return { results, failures: results.filter((result) => result.failed).length };
  }

  private async describeFrame(input: FrameDescriptionInput): Promise<FrameDescriptionResult> {
    try {
      const buffer = readFileSync(input.framePath);
      const description = await withRetry(
        () => this.generateDescription(input, buffer),
        { maxRetries: 3, isRetryable: isRetryableGeminiError },
      );
      return { framePath: input.framePath, description };
    } catch {
      // Retries exhausted or non-retryable (quota/auth/read) — surface as a failure, not a
      // silent empty description, so the caller does not stamp "gemini" on an undescribed frame.
      return { framePath: input.framePath, failed: true };
    }
  }

  private async generateDescription(input: FrameDescriptionInput, buffer: Buffer): Promise<string | undefined> {
    const response = await this.client!.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "You are indexing a single frame from a YouTube video for retrieval.",
                "Describe only visually verifiable content in one or two concise sentences.",
                "Mention visible on-screen text if it materially helps retrieval.",
                "Do not speculate about events outside the frame.",
                `Video ID: ${input.videoId}`,
                `Timestamp: ${Math.round(input.timestampSec)}s`,
                "Return plain text only.",
              ].join("\n"),
            },
            {
              inlineData: {
                mimeType: guessMimeType(input.framePath),
                data: buffer.toString("base64"),
              },
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 120,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    } as any);

    return normalizeText(extractText(response));
  }
}

/** Gemini SDK errors don't always carry a numeric status — also match quota/rate-limit text. */
function isRetryableGeminiError(error: unknown): boolean {
  if (isRetryableError(error)) return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("resource_exhausted") ||
    message.includes("unavailable") ||
    message.includes("overloaded") ||
    message.includes("503") ||
    message.includes("500")
  );
}

function extractText(response: any): string | undefined {
  if (typeof response?.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  const parts = response?.candidates?.flatMap((candidate: any) => candidate?.content?.parts ?? []) ?? [];
  const text = parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  return text || undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function guessMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".jpeg":
    case ".jpg":
    default:
      return "image/jpeg";
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}
