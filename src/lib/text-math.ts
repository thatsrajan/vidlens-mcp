/**
 * Shared text/vector math for the transcript and comment knowledge bases.
 *
 * Both knowledge bases use the same TF-IDF + latent-semantic (LSA) approach for
 * local search. These helpers were previously duplicated verbatim in
 * knowledge-base.ts and comment-knowledge-base.ts; they now live here as the
 * single source of truth so the two stores cannot drift apart.
 */
import type { Provenance } from "./types.js";

export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have",
  "how", "if", "in", "into", "is", "it", "its", "just", "more", "most", "not", "of", "on", "or", "our",
  "that", "the", "their", "there", "these", "they", "this", "those", "to", "too", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

// ── Tokenization ──

export function buildTermCounts(text: string): Record<string, number> {
  const words = tokenize(text);
  const counts: Record<string, number> = {};
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    counts[word] = (counts[word] ?? 0) + 1;
    const next = words[index + 1];
    if (next) {
      const bigram = `${word}_${next}`;
      counts[bigram] = (counts[bigram] ?? 0) + 1;
    }
  }
  return counts;
}

export function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  return normalized
    .split(/\s+/)
    .map((token) => stem(token.trim()))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function stem(token: string): string {
  let current = token;
  if (current.endsWith("ies") && current.length > 4) {
    current = `${current.slice(0, -3)}y`;
  } else if (current.endsWith("ing") && current.length > 5) {
    current = current.slice(0, -3);
  } else if (current.endsWith("ed") && current.length > 4) {
    current = current.slice(0, -2);
  } else if (current.endsWith("ly") && current.length > 4) {
    current = current.slice(0, -2);
  } else if (current.endsWith("es") && current.length > 4) {
    current = current.slice(0, -2);
  } else if (current.endsWith("s") && current.length > 3) {
    current = current.slice(0, -1);
  }
  return current;
}

// ── TF-IDF ──

export function buildIdfMap(documents: Array<Record<string, number>>): Record<string, number> {
  const docCount = documents.length;
  const df = new Map<string, number>();
  for (const document of documents) {
    for (const token of Object.keys(document)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const rankedTokens = Array.from(df.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4000);

  return Object.fromEntries(
    rankedTokens.map(([token, frequency]) => [token, 1 + Math.log((docCount + 1) / (frequency + 1))]),
  );
}

export function buildNormalizedVector(terms: Record<string, number>, idf: Record<string, number>): Record<string, number> {
  const weighted: Record<string, number> = {};
  let normSquared = 0;
  for (const [token, count] of Object.entries(terms)) {
    const tokenIdf = idf[token];
    if (!tokenIdf) {
      continue;
    }
    const weight = (1 + Math.log(count)) * tokenIdf;
    weighted[token] = weight;
    normSquared += weight * weight;
  }

  const norm = Math.sqrt(normSquared) || 1;
  for (const token of Object.keys(weighted)) {
    weighted[token] = weighted[token] / norm;
  }
  return weighted;
}

export function lexicalSimilarity(
  docTerms: Record<string, number>,
  queryVector: Record<string, number>,
  queryNorm: number,
  idf: Record<string, number>,
): number {
  if (queryNorm <= 0) {
    return 0;
  }
  let dotProduct = 0;
  let docNormSquared = 0;
  for (const [token, count] of Object.entries(docTerms)) {
    const tokenIdf = idf[token];
    if (!tokenIdf) {
      continue;
    }
    const docWeight = (1 + Math.log(count)) * tokenIdf;
    docNormSquared += docWeight * docWeight;
    if (queryVector[token]) {
      dotProduct += docWeight * queryVector[token];
    }
  }

  const docNorm = Math.sqrt(docNormSquared) || 1;
  return dotProduct / (docNorm * Math.max(queryNorm, 1));
}

// ── Latent semantic decomposition ──

export function buildSimilarityMatrix(vectors: Array<Record<string, number>>): Float64Array {
  const size = vectors.length;
  const matrix = new Float64Array(size * size);
  const inverted = new Map<string, Array<{ index: number; weight: number }>>();

  vectors.forEach((vector, index) => {
    for (const [token, weight] of Object.entries(vector)) {
      const bucket = inverted.get(token) ?? [];
      bucket.push({ index, weight });
      inverted.set(token, bucket);
    }
  });

  for (const postings of inverted.values()) {
    for (let left = 0; left < postings.length; left += 1) {
      const a = postings[left];
      for (let right = left; right < postings.length; right += 1) {
        const b = postings[right];
        const contribution = a.weight * b.weight;
        matrix[a.index * size + b.index] += contribution;
        if (a.index !== b.index) {
          matrix[b.index * size + a.index] += contribution;
        }
      }
    }
  }

  return matrix;
}

export function decomposeSimilarity(matrix: Float64Array, size: number): { sigma: number[]; embeddings: number[][] } {
  const sigma: number[] = [];
  const eigenvectors: number[][] = [];
  const maxComponents = Math.min(size, 12);

  for (let component = 0; component < maxComponents; component += 1) {
    let vector = Array.from({ length: size }, (_, index) => ((index + 1) * (component + 3)) % 7 + 1);
    vector = normalizeDense(vector);

    for (let iteration = 0; iteration < 20; iteration += 1) {
      let multiplied = multiplyMatrixVector(matrix, size, vector);
      for (const previous of eigenvectors) {
        const projection = dot(previous, multiplied);
        multiplied = multiplied.map((value, index) => value - projection * previous[index]);
      }
      const magnitude = magnitudeOf(multiplied);
      if (magnitude < 1e-9) {
        break;
      }
      vector = multiplied.map((value) => value / magnitude);
    }

    const projected = multiplyMatrixVector(matrix, size, vector);
    const eigenvalue = dot(vector, projected);
    if (!Number.isFinite(eigenvalue) || eigenvalue <= 1e-8) {
      break;
    }

    sigma.push(Math.sqrt(eigenvalue));
    eigenvectors.push(vector);
  }

  const embeddings = Array.from({ length: size }, () => Array.from({ length: sigma.length }, () => 0));
  for (let index = 0; index < size; index += 1) {
    for (let component = 0; component < sigma.length; component += 1) {
      embeddings[index][component] = eigenvectors[component][index] * sigma[component];
    }
  }

  return { sigma, embeddings };
}

// ── Semantic scoring ──

/**
 * Approximate the query's position in latent space from the lexically-relevant
 * documents, then score every document by cosine similarity to it.
 */
export function semanticSimilarities(embeddings: number[][], lexicalScores: number[], sigma: number[]): Array<number | undefined> {
  const queryEmbedding = Array.from({ length: sigma.length }, () => 0);
  for (let index = 0; index < embeddings.length; index += 1) {
    const lexicalScore = lexicalScores[index] ?? 0;
    if (lexicalScore <= 0) {
      continue;
    }
    const embedding = embeddings[index];
    for (let component = 0; component < sigma.length; component += 1) {
      const divisor = sigma[component] ** 2 || 1;
      queryEmbedding[component] += lexicalScore * ((embedding[component] ?? 0) / divisor);
    }
  }

  return cosineSimilarities(embeddings, queryEmbedding);
}

export function cosineSimilarities(embeddings: number[][], queryEmbedding: number[]): Array<number | undefined> {
  const queryMagnitude = magnitudeOf(queryEmbedding);
  if (queryMagnitude <= 1e-9) {
    return embeddings.map(() => undefined);
  }

  return embeddings.map((embedding) => {
    const magnitude = magnitudeOf(embedding);
    if (magnitude <= 1e-9) {
      return undefined;
    }
    return dot(queryEmbedding, embedding) / (queryMagnitude * magnitude);
  });
}

// ── Dense-vector math ──

export function vectorNorm(vector: Record<string, number>): number {
  return Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0));
}

export function multiplyMatrixVector(matrix: Float64Array, size: number, vector: number[]): number[] {
  const result = new Array<number>(size).fill(0);
  for (let row = 0; row < size; row += 1) {
    let total = 0;
    const offset = row * size;
    for (let column = 0; column < size; column += 1) {
      total += matrix[offset + column] * vector[column];
    }
    result[row] = total;
  }
  return result;
}

export function normalizeDense(values: number[]): number[] {
  const magnitude = magnitudeOf(values);
  if (magnitude <= 1e-9) {
    return values;
  }
  return values.map((value) => value / magnitude);
}

export function magnitudeOf(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0));
}

export function dot(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

// ── Misc ──

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "collection";
}

export function safeParseCounts(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function safeParseNumberMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function safeParseNumberArray(value: string | null | undefined): number[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as number[];
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : [];
  } catch {
    return [];
  }
}

export function buildLocalProvenance(sourceNote: string): Provenance {
  return {
    sourceTier: "none",
    fetchedAt: new Date().toISOString(),
    fallbackDepth: 3,
    partial: false,
    sourceNotes: [sourceNote],
  };
}
