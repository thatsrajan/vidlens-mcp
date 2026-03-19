import { GoogleGenAI } from "@google/genai";

export type EmbeddingProviderKind = "local" | "gemini";

export interface EmbeddingSelection {
  kind: EmbeddingProviderKind;
  model?: string;
  dimensions?: number;
}

export interface EmbeddingProvider {
  readonly selection: EmbeddingSelection;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

const DEFAULT_GEMINI_MODEL = process.env.YOUTUBE_MCP_GEMINI_MODEL || "gemini-embedding-2-preview";
const DEFAULT_GEMINI_DIMENSIONS = Number(process.env.YOUTUBE_MCP_GEMINI_DIMENSIONS || 768);
const GEMINI_PROVIDER_CACHE = new Map<string, Promise<EmbeddingProvider | null>>();

export function resolveEmbeddingSelection(input?: {
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}): EmbeddingSelection {
  const kind = (input?.embeddingProvider ?? process.env.VIDLENS_EMBEDDING_PROVIDER ?? "local").toLowerCase();
  if (kind === "gemini") {
    return {
      kind: "gemini",
      model: input?.embeddingModel ?? DEFAULT_GEMINI_MODEL,
      dimensions: normalizeDimensions(input?.embeddingDimensions ?? DEFAULT_GEMINI_DIMENSIONS),
    };
  }

  return { kind: "local" };
}

export function selectionToAlgorithm(selection: EmbeddingSelection): string {
  if (selection.kind === "gemini") {
    return `gemini:${selection.model ?? DEFAULT_GEMINI_MODEL}:${selection.dimensions ?? DEFAULT_GEMINI_DIMENSIONS}`;
  }
  return "local-lsa-hybrid-v1";
}

export function parseAlgorithmSelection(algorithm: string): EmbeddingSelection {
  if (algorithm.startsWith("gemini:")) {
    const [, model, dimensions] = algorithm.split(":");
    return {
      kind: "gemini",
      model: model || DEFAULT_GEMINI_MODEL,
      dimensions: normalizeDimensions(Number(dimensions || DEFAULT_GEMINI_DIMENSIONS)),
    };
  }
  return { kind: "local" };
}

export function embeddingSelectionLabel(selection: EmbeddingSelection): string {
  return selection.kind === "gemini"
    ? `${selection.kind}:${selection.model}:${selection.dimensions}`
    : "local-lsa-hybrid-v1";
}

export async function createEmbeddingProvider(selection: EmbeddingSelection): Promise<EmbeddingProvider | null> {
  if (selection.kind !== "gemini") {
    return null;
  }

  const model = selection.model ?? DEFAULT_GEMINI_MODEL;
  const dimensions = normalizeDimensions(selection.dimensions ?? DEFAULT_GEMINI_DIMENSIONS);
  const cacheKey = `gemini:${model}:${dimensions}`;
  const cached = GEMINI_PROVIDER_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const providerPromise = createGeminiProvider({ model, dimensions });
  GEMINI_PROVIDER_CACHE.set(cacheKey, providerPromise);
  return providerPromise;
}

async function createGeminiProvider(selection: { model: string; dimensions: number }): Promise<EmbeddingProvider | null> {
  const { model, dimensions } = selection;

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini embedding provider selected but GEMINI_API_KEY/GOOGLE_API_KEY is not set.");
  }

  let client: GoogleGenAI | null = null;
  const getClient = (): GoogleGenAI => client ??= new GoogleGenAI({ apiKey });

  return {
    selection: {
      kind: "gemini",
      model,
      dimensions,
    },
    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const client = getClient();
      const allEmbeddings: number[][] = [];
      for (const batch of chunk(texts, 16)) {
        const response = await client.models.embedContent({
          model,
          contents: batch,
          config: {
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: dimensions,
          },
        });
        const embeddings = readEmbeddings(response);
        allEmbeddings.push(...embeddings.map(normalize));
      }
      return allEmbeddings;
    },
    async embedQuery(text: string): Promise<number[]> {
      const client = getClient();
      const response = await client.models.embedContent({
        model,
        contents: text,
        config: {
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: dimensions,
        },
      });
      return normalize(readFirstEmbedding(response));
    },
  };
}

function readEmbeddings(response: unknown): number[][] {
  if (response && typeof response === "object") {
    const value = response as { embeddings?: Array<{ values?: number[] }>; embedding?: { values?: number[] } };
    if (Array.isArray(value.embeddings) && value.embeddings.length > 0) {
      return value.embeddings.map((item) => item.values ?? []).filter((values) => values.length > 0);
    }
    if (value.embedding?.values?.length) {
      return [value.embedding.values];
    }
  }
  throw new Error("Gemini embeddings response did not include embedding values.");
}

function readFirstEmbedding(response: unknown): number[] {
  const embeddings = readEmbeddings(response);
  if (embeddings.length === 0) {
    throw new Error("Gemini embeddings response was empty.");
  }
  return embeddings[0];
}

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0));
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) {
    return values;
  }
  return values.map((value) => value / magnitude);
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function normalizeDimensions(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GEMINI_DIMENSIONS;
  }
  return Math.max(128, Math.min(Math.round(value), 3072));
}
