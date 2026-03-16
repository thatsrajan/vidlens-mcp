import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { GoogleGenAI } from "@google/genai";

export interface FrameDescriptionInput {
  framePath: string;
  videoId: string;
  timestampSec: number;
}

export interface FrameDescriptionResult {
  framePath: string;
  description?: string;
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

  async describeFrames(inputs: FrameDescriptionInput[]): Promise<FrameDescriptionResult[]> {
    if (!this.client || inputs.length === 0) {
      return inputs.map((input) => ({ framePath: input.framePath }));
    }

    const results: FrameDescriptionResult[] = [];
    for (const batch of chunk(inputs, 5)) {
      const batchResults = await Promise.all(batch.map((input) => this.describeFrame(input)));
      results.push(...batchResults);
    }
    return results;
  }

  private async describeFrame(input: FrameDescriptionInput): Promise<FrameDescriptionResult> {
    try {
      const buffer = readFileSync(input.framePath);
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

      return {
        framePath: input.framePath,
        description: normalizeText(extractText(response)),
      };
    } catch {
      return { framePath: input.framePath };
    }
  }
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
