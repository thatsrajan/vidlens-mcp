import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createEmbeddingProvider,
  resolveEmbeddingSelection,
  type EmbeddingSelection,
} from "./embedding-provider.js";
import type { MediaAsset } from "./media-store.js";
import { MediaStore } from "./media-store.js";
import { MediaDownloader } from "./media-downloader.js";
import { ThumbnailExtractor } from "./thumbnail-extractor.js";
import { GeminiVisualDescriber } from "./gemini-visual-describer.js";
import { MacOSVisionAnalyzer } from "./macos-vision.js";

export interface VisualIndexRecord {
  frameId: string;
  videoId: string;
  frameAssetId?: string;
  framePath: string;
  timestampSec: number;
  sourceVideoUrl: string;
  sourceVideoTitle?: string;
  ocrText?: string;
  ocrConfidence?: number;
  visualDescription?: string;
  retrievalText?: string;
  featureVector?: number[];
  textEmbedding?: number[];
  descriptionModel?: string;
  embeddingProvider?: "none" | "gemini";
  embeddingModel?: string;
  embeddingDimensions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface IndexVisualContentParams {
  videoId: string;
  sourceVideoTitle?: string;
  sourceVideoUrl?: string;
  intervalSec?: number;
  maxFrames?: number;
  imageFormat?: "jpg" | "png" | "webp";
  width?: number;
  autoDownload?: boolean;
  downloadFormat?: "best_video" | "worst_video";
  forceReindex?: boolean;
  includeGeminiDescriptions?: boolean;
  includeGeminiEmbeddings?: boolean;
}

export interface IndexVisualContentResult {
  videoId: string;
  sourceVideoUrl: string;
  sourceVideoTitle?: string;
  videoAssetPath?: string;
  autoDownloaded: boolean;
  framesExtracted: number;
  framesAnalyzed: number;
  framesIndexed: number;
  intervalSec: number;
  maxFrames: number;
  descriptionProvider: "none" | "gemini";
  descriptionModel?: string;
  embeddingProvider: "none" | "gemini";
  embeddingModel?: string;
  embeddingDimensions?: number;
  evidence: VisualIndexRecord[];
  limitations: string[];
}

export interface SearchVisualContentParams {
  query: string;
  videoId?: string;
  maxResults?: number;
  minScore?: number;
  autoIndexIfNeeded?: boolean;
  indexIfNeeded?: Omit<IndexVisualContentParams, "videoId">;
}

export interface SearchVisualMatch {
  score: number;
  lexicalScore: number;
  semanticScore?: number;
  matchedOn: Array<"ocr" | "description" | "semantic">;
  videoId: string;
  sourceVideoUrl: string;
  sourceVideoTitle?: string;
  frameAssetId?: string;
  framePath: string;
  timestampSec: number;
  timestampLabel: string;
  explanation: string;
  ocrText?: string;
  visualDescription?: string;
}

export interface SearchVisualContentResult {
  query: string;
  results: SearchVisualMatch[];
  searchedFrames: number;
  searchedVideos: number;
  descriptionProvider: "none" | "gemini" | "mixed";
  embeddingProvider: "none" | "gemini" | "mixed";
  embeddingModel?: string;
  queryMode: "ocr_description_lexical" | "gemini_semantic_plus_lexical";
  limitations: string[];
}

export interface FindSimilarFramesParams {
  assetId?: string;
  framePath?: string;
  videoId?: string;
  maxResults?: number;
  minSimilarity?: number;
}

export interface SimilarFrameMatch {
  similarity: number;
  videoId: string;
  sourceVideoUrl: string;
  sourceVideoTitle?: string;
  frameAssetId?: string;
  framePath: string;
  timestampSec: number;
  timestampLabel: string;
  explanation: string;
  ocrText?: string;
  visualDescription?: string;
}

export interface FindSimilarFramesResult {
  reference: {
    assetId?: string;
    framePath: string;
    videoId?: string;
  };
  results: SimilarFrameMatch[];
  searchedFrames: number;
  limitations: string[];
}

interface VisualIndexStoreConfig {
  dataDir?: string;
}

interface RawVisualRow {
  frame_id: string;
  video_id: string;
  frame_asset_id: string | null;
  frame_path: string;
  timestamp_sec: number;
  source_video_url: string;
  source_video_title: string | null;
  ocr_text: string | null;
  ocr_confidence: number | null;
  visual_description: string | null;
  retrieval_text: string | null;
  feature_vector_json: string | null;
  text_embedding_json: string | null;
  description_model: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  created_at: string;
  updated_at: string;
}

export class VisualIndexStore {
  private readonly db: DatabaseSync;
  readonly dataDir: string;

  constructor(config: VisualIndexStoreConfig = {}) {
    this.dataDir = resolveVisualDataDir(config.dataDir);
    const dbPath = join(this.dataDir, "visual-index.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS visual_frames (
        frame_id            TEXT PRIMARY KEY,
        video_id            TEXT NOT NULL,
        frame_asset_id      TEXT,
        frame_path          TEXT NOT NULL UNIQUE,
        timestamp_sec       REAL NOT NULL,
        source_video_url    TEXT NOT NULL,
        source_video_title  TEXT,
        ocr_text            TEXT,
        ocr_confidence      REAL,
        visual_description  TEXT,
        retrieval_text      TEXT,
        feature_vector_json TEXT,
        text_embedding_json TEXT,
        description_model   TEXT,
        embedding_provider  TEXT,
        embedding_model     TEXT,
        embedding_dimensions INTEGER,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_visual_video ON visual_frames(video_id);
      CREATE INDEX IF NOT EXISTS idx_visual_time ON visual_frames(video_id, timestamp_sec);
    `);

    ensureColumn(this.db, "visual_frames", "retrieval_text", "TEXT");
    ensureColumn(this.db, "visual_frames", "text_embedding_json", "TEXT");
    ensureColumn(this.db, "visual_frames", "embedding_provider", "TEXT");
    ensureColumn(this.db, "visual_frames", "embedding_model", "TEXT");
    ensureColumn(this.db, "visual_frames", "embedding_dimensions", "INTEGER");
  }

  upsertFrame(input: Omit<VisualIndexRecord, "frameId" | "createdAt" | "updatedAt"> & { frameId?: string }): VisualIndexRecord {
    const existing = this.getByPath(input.framePath);
    const frameId = existing?.frameId ?? input.frameId ?? randomUUID();
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO visual_frames (
        frame_id, video_id, frame_asset_id, frame_path, timestamp_sec, source_video_url, source_video_title,
        ocr_text, ocr_confidence, visual_description, retrieval_text, feature_vector_json, text_embedding_json,
        description_model, embedding_provider, embedding_model, embedding_dimensions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(frame_path) DO UPDATE SET
        video_id = excluded.video_id,
        frame_asset_id = excluded.frame_asset_id,
        timestamp_sec = excluded.timestamp_sec,
        source_video_url = excluded.source_video_url,
        source_video_title = excluded.source_video_title,
        ocr_text = excluded.ocr_text,
        ocr_confidence = excluded.ocr_confidence,
        visual_description = excluded.visual_description,
        retrieval_text = excluded.retrieval_text,
        feature_vector_json = excluded.feature_vector_json,
        text_embedding_json = excluded.text_embedding_json,
        description_model = excluded.description_model,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        updated_at = excluded.updated_at
    `).run(
      frameId,
      input.videoId,
      input.frameAssetId ?? null,
      input.framePath,
      input.timestampSec,
      input.sourceVideoUrl,
      input.sourceVideoTitle ?? null,
      input.ocrText ?? null,
      input.ocrConfidence ?? null,
      input.visualDescription ?? null,
      input.retrievalText ?? null,
      input.featureVector ? JSON.stringify(input.featureVector) : null,
      input.textEmbedding ? JSON.stringify(input.textEmbedding) : null,
      input.descriptionModel ?? null,
      input.embeddingProvider ?? null,
      input.embeddingModel ?? null,
      input.embeddingDimensions ?? null,
      createdAt,
      updatedAt,
    );

    return this.getByPath(input.framePath)!;
  }

  getByPath(framePath: string): VisualIndexRecord | null {
    const row = this.db.prepare("SELECT * FROM visual_frames WHERE frame_path = ?").get(framePath) as RawVisualRow | undefined;
    return row ? rowToVisualRecord(row) : null;
  }

  getByAssetId(assetId: string): VisualIndexRecord | null {
    const row = this.db.prepare("SELECT * FROM visual_frames WHERE frame_asset_id = ? ORDER BY updated_at DESC LIMIT 1").get(assetId) as RawVisualRow | undefined;
    return row ? rowToVisualRecord(row) : null;
  }

  listFrames(options: { videoId?: string } = {}): VisualIndexRecord[] {
    if (options.videoId) {
      const rows = this.db.prepare("SELECT * FROM visual_frames WHERE video_id = ? ORDER BY timestamp_sec ASC").all(options.videoId) as unknown as RawVisualRow[];
      return rows.map(rowToVisualRecord);
    }
    const rows = this.db.prepare("SELECT * FROM visual_frames ORDER BY updated_at DESC").all() as unknown as RawVisualRow[];
    return rows.map(rowToVisualRecord);
  }

  countFrames(videoId?: string): number {
    if (videoId) {
      const row = this.db.prepare("SELECT COUNT(*) AS count FROM visual_frames WHERE video_id = ?").get(videoId) as { count: number };
      return row.count;
    }
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM visual_frames").get() as { count: number };
    return row.count;
  }

  removeFramesForVideo(videoId: string): number {
    const count = this.countFrames(videoId);
    this.db.prepare("DELETE FROM visual_frames WHERE video_id = ?").run(videoId);
    return count;
  }

  close(): void {
    this.db.close();
  }
}

export class VisualSearchEngine {
  readonly store: VisualIndexStore;
  readonly geminiDescriber: GeminiVisualDescriber;
  readonly visionAnalyzer: MacOSVisionAnalyzer;

  constructor(
    private readonly mediaStore: MediaStore,
    private readonly mediaDownloader: MediaDownloader,
    private readonly thumbnailExtractor: ThumbnailExtractor,
    config: { dataDir?: string; store?: VisualIndexStore; visionAnalyzer?: MacOSVisionAnalyzer; geminiDescriber?: GeminiVisualDescriber } = {},
  ) {
    this.store = config.store ?? new VisualIndexStore({ dataDir: config.dataDir });
    this.visionAnalyzer = config.visionAnalyzer ?? new MacOSVisionAnalyzer();
    this.geminiDescriber = config.geminiDescriber ?? new GeminiVisualDescriber();
  }

  async indexVideo(params: IndexVisualContentParams): Promise<IndexVisualContentResult> {
    const videoId = params.videoId;
    const sourceVideoUrl = params.sourceVideoUrl ?? `https://www.youtube.com/watch?v=${videoId}`;
    const intervalSec = clamp(params.intervalSec ?? 20, 2, 3600);
    const maxFrames = clamp(params.maxFrames ?? 12, 1, 100);

    const includeGeminiDescriptions = params.includeGeminiDescriptions ?? this.geminiDescriber.available;
    const descriptionProvider: "none" | "gemini" = includeGeminiDescriptions && this.geminiDescriber.available ? "gemini" : "none";

    const embeddingSelection = resolveGeminiEmbeddingSelection(params.includeGeminiEmbeddings);
    const embeddingProvider = embeddingSelection ? await createEmbeddingProvider(embeddingSelection) : null;
    const embeddingProviderKind: "none" | "gemini" = embeddingProvider ? "gemini" : "none";

    if (params.forceReindex) {
      this.store.removeFramesForVideo(videoId);
    }

    let autoDownloaded = false;
    let videoAssetPath = this.findVideoAsset(videoId)?.filePath;
    if (!videoAssetPath && (params.autoDownload ?? true)) {
      const download = await this.mediaDownloader.download({
        videoIdOrUrl: videoId,
        format: params.downloadFormat ?? "best_video",
      });
      videoAssetPath = download.asset.filePath;
      autoDownloaded = true;
    }

    if (!videoAssetPath) {
      throw new Error(`No local video asset found for ${videoId}. Run downloadAsset first or allow autoDownload.`);
    }

    const keyframes = await this.thumbnailExtractor.extractKeyframes({
      videoId,
      videoPath: videoAssetPath,
      intervalSec,
      maxFrames,
      imageFormat: params.imageFormat,
      width: params.width,
    });

    const existingByPath = new Map(this.store.listFrames({ videoId }).map((frame) => [frame.framePath, frame]));
    const pendingAssets = keyframes.assets.filter((asset) => params.forceReindex || !existingByPath.has(asset.filePath));

    // Run OCR and Gemini descriptions IN PARALLEL — they're independent
    const [analyses, descriptions] = await Promise.all([
      pendingAssets.length > 0
        ? this.visionAnalyzer.analyzeFrames(pendingAssets.map((asset) => asset.filePath))
        : Promise.resolve([]),
      descriptionProvider === "gemini"
      ? this.geminiDescriber.describeFrames(pendingAssets.map((asset) => ({
        framePath: asset.filePath,
        videoId,
        timestampSec: asset.timestampSec ?? 0,
      })))
      : Promise.resolve([]),
    ]);
    const analysisByPath = new Map(analyses.map((analysis) => [analysis.framePath, analysis]));
    const descriptionByPath = new Map(descriptions.map((item) => [item.framePath, item.description]));

    const retrievalTexts = pendingAssets.map((asset) => {
      const analysis = analysisByPath.get(asset.filePath);
      const description = descriptionByPath.get(asset.filePath);
      return buildRetrievalText({
        timestampSec: asset.timestampSec ?? 0,
        ocrText: analysis?.ocrText,
        visualDescription: description,
      });
    });

    const textEmbeddings = embeddingProvider
      ? await embeddingProvider.embedDocuments(retrievalTexts.map((text) => text || "frame without visible text"))
      : [];
    const embeddingByPath = new Map<string, number[]>();
    pendingAssets.forEach((asset, index) => {
      if (textEmbeddings[index]?.length) {
        embeddingByPath.set(asset.filePath, textEmbeddings[index]!);
      }
    });

    const evidence: VisualIndexRecord[] = [];
    for (const asset of keyframes.assets) {
      const existing = existingByPath.get(asset.filePath);
      if (existing && !params.forceReindex) {
        evidence.push(existing);
        continue;
      }

      const analysis = analysisByPath.get(asset.filePath);
      const visualDescription = descriptionByPath.get(asset.filePath);
      const retrievalText = buildRetrievalText({
        timestampSec: asset.timestampSec ?? 0,
        ocrText: analysis?.ocrText,
        visualDescription,
      });

      const record = this.store.upsertFrame({
        videoId,
        frameAssetId: asset.assetId,
        framePath: asset.filePath,
        timestampSec: asset.timestampSec ?? 0,
        sourceVideoUrl,
        sourceVideoTitle: params.sourceVideoTitle,
        ocrText: analysis?.ocrText,
        ocrConfidence: analysis?.ocrConfidence,
        visualDescription,
        retrievalText,
        featureVector: analysis?.featureVector,
        textEmbedding: embeddingByPath.get(asset.filePath),
        descriptionModel: descriptionProvider === "gemini" ? this.geminiDescriber.model : undefined,
        embeddingProvider: embeddingProviderKind,
        embeddingModel: embeddingProvider?.selection.model,
        embeddingDimensions: embeddingProvider?.selection.dimensions,
      });
      evidence.push(record);
    }

    return {
      videoId,
      sourceVideoUrl,
      sourceVideoTitle: params.sourceVideoTitle,
      videoAssetPath,
      autoDownloaded,
      framesExtracted: keyframes.framesExtracted,
      framesAnalyzed: pendingAssets.length,
      framesIndexed: evidence.length,
      intervalSec,
      maxFrames,
      descriptionProvider,
      descriptionModel: descriptionProvider === "gemini" ? this.geminiDescriber.model : undefined,
      embeddingProvider: embeddingProviderKind,
      embeddingModel: embeddingProvider?.selection.model,
      embeddingDimensions: embeddingProvider?.selection.dimensions,
      evidence: evidence.sort((a, b) => a.timestampSec - b.timestampSec).slice(0, 12),
      limitations: buildIndexLimitations(descriptionProvider, embeddingProviderKind),
    };
  }

  async searchText(params: SearchVisualContentParams): Promise<SearchVisualContentResult> {
    const rawQuery = params.query?.trim();
    const normalizedQuery = normalizeText(rawQuery);
    if (!normalizedQuery) {
      throw new Error("query cannot be empty");
    }

    if (params.videoId && (params.autoIndexIfNeeded ?? true) && this.store.countFrames(params.videoId) === 0) {
      await this.indexVideo({
        videoId: params.videoId,
        ...(params.indexIfNeeded ?? {}),
      });
    }

    const frames = this.store.listFrames({ videoId: params.videoId }).filter((frame) => existsSync(frame.framePath));
    if (frames.length === 0) {
      throw new Error("No indexed visual frames found. Run indexVisualContent first, or provide videoIdOrUrl so search can auto-index it.");
    }

    const embeddingSummary = summarizeEmbeddingProvider(frames);
    let semanticQueryEmbedding: number[] | undefined;

    if (embeddingSummary.provider !== "none") {
      const selection: EmbeddingSelection = {
        kind: "gemini",
        model: embeddingSummary.model,
        dimensions: embeddingSummary.dimensions,
      };
      const provider = await createEmbeddingProvider(selection);
      semanticQueryEmbedding = provider ? await provider.embedQuery(rawQuery ?? normalizedQuery) : undefined;
    }

    const results = frames
      .map((frame) => scoreFrameAgainstQuery({ query: normalizedQuery, rawQuery: rawQuery ?? normalizedQuery, frame, semanticQueryEmbedding }))
      .filter((item) => item.score >= (params.minScore ?? 0.12))
      .sort((a, b) => b.score - a.score || b.semanticScore! - a.semanticScore! || b.lexicalScore - a.lexicalScore)
      .slice(0, clamp(params.maxResults ?? 5, 1, 20));

    return {
      query: rawQuery ?? normalizedQuery,
      results,
      searchedFrames: frames.length,
      searchedVideos: new Set(frames.map((frame) => frame.videoId)).size,
      descriptionProvider: summarizeDescriptionProvider(frames),
      embeddingProvider: embeddingSummary.provider,
      embeddingModel: embeddingSummary.model,
      queryMode: semanticQueryEmbedding ? "gemini_semantic_plus_lexical" : "ocr_description_lexical",
      limitations: buildSearchLimitations(summarizeDescriptionProvider(frames), embeddingSummary.provider),
    };
  }

  async findSimilarFrames(params: FindSimilarFramesParams): Promise<FindSimilarFramesResult> {
    const reference = await this.resolveReferenceFrame(params);
    const referenceVector = reference.featureVector;
    if (!referenceVector || referenceVector.length === 0) {
      throw new Error("Reference frame does not have an Apple Vision feature vector. Re-index the frame or provide a valid image path.");
    }

    const candidates = this.store.listFrames({ videoId: params.videoId }).filter((frame) => {
      if (!existsSync(frame.framePath)) return false;
      if (!frame.featureVector || frame.featureVector.length === 0) return false;
      if (frame.framePath === reference.framePath) return false;
      return true;
    });

    const minSimilarity = params.minSimilarity ?? 0.7;
    const results = candidates
      .map((frame) => ({ frame, similarity: cosineSimilarity(referenceVector, frame.featureVector ?? []) }))
      .filter((item) => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, clamp(params.maxResults ?? 5, 1, 20))
      .map(({ frame, similarity }) => ({
        similarity: round(similarity, 4),
        videoId: frame.videoId,
        sourceVideoUrl: frame.sourceVideoUrl,
        sourceVideoTitle: frame.sourceVideoTitle,
        frameAssetId: frame.frameAssetId,
        framePath: frame.framePath,
        timestampSec: frame.timestampSec,
        timestampLabel: formatTimestamp(frame.timestampSec),
        explanation: `Apple Vision feature-print similarity ${round(similarity, 3)}${frame.visualDescription ? ` • ${truncate(frame.visualDescription, 140)}` : ""}`,
        ocrText: frame.ocrText,
        visualDescription: frame.visualDescription,
      } satisfies SimilarFrameMatch));

    return {
      reference: {
        assetId: params.assetId,
        framePath: reference.framePath,
        videoId: reference.videoId,
      },
      results,
      searchedFrames: candidates.length,
      limitations: [
        "Similarity is image-to-image only. It finds frames that look alike using Apple Vision feature prints.",
        "Similarity search does not understand transcript text. It only compares visual frame features.",
      ],
    };
  }

  private findVideoAsset(videoId: string): MediaAsset | undefined {
    return this.mediaStore.listAssetsForVideo(videoId).find((asset) => asset.kind === "video" && existsSync(asset.filePath));
  }

  private async resolveReferenceFrame(params: FindSimilarFramesParams): Promise<VisualIndexRecord> {
    if (params.assetId) {
      const indexed = this.store.getByAssetId(params.assetId);
      if (indexed) return indexed;
      const mediaAsset = this.mediaStore.getAsset(params.assetId);
      if (!mediaAsset?.filePath) {
        throw new Error(`No visual frame found for assetId ${params.assetId}`);
      }
      return this.analyzeAdHocFrame(mediaAsset.filePath, mediaAsset.videoId, params.assetId, mediaAsset.timestampSec ?? 0);
    }

    if (params.framePath) {
      const indexed = this.store.getByPath(params.framePath);
      if (indexed) return indexed;
      return this.analyzeAdHocFrame(params.framePath, params.videoId, undefined, 0);
    }

    throw new Error("Provide either assetId or framePath to find similar frames.");
  }

  private async analyzeAdHocFrame(framePath: string, videoId?: string, assetId?: string, timestampSec = 0): Promise<VisualIndexRecord> {
    const analysis = await this.visionAnalyzer.analyzeFrames([framePath]);
    const first = analysis[0];
    return {
      frameId: randomUUID(),
      videoId: videoId ?? "external",
      frameAssetId: assetId,
      framePath,
      timestampSec,
      sourceVideoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : framePath,
      ocrText: first?.ocrText,
      ocrConfidence: first?.ocrConfidence,
      featureVector: first?.featureVector,
      retrievalText: buildRetrievalText({ timestampSec, ocrText: first?.ocrText }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

function resolveVisualDataDir(baseDataDir?: string): string {
  const root = baseDataDir ?? process.env.VIDLENS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "vidlens-mcp");
  const dir = join(root, "visual");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rowToVisualRecord(row: RawVisualRow): VisualIndexRecord {
  return {
    frameId: row.frame_id,
    videoId: row.video_id,
    frameAssetId: row.frame_asset_id ?? undefined,
    framePath: row.frame_path,
    timestampSec: row.timestamp_sec,
    sourceVideoUrl: row.source_video_url,
    sourceVideoTitle: row.source_video_title ?? undefined,
    ocrText: row.ocr_text ?? undefined,
    ocrConfidence: row.ocr_confidence ?? undefined,
    visualDescription: row.visual_description ?? undefined,
    retrievalText: row.retrieval_text ?? undefined,
    featureVector: row.feature_vector_json ? normalizeVector(JSON.parse(row.feature_vector_json) as number[]) : undefined,
    textEmbedding: row.text_embedding_json ? normalizeVector(JSON.parse(row.text_embedding_json) as number[]) : undefined,
    descriptionModel: row.description_model ?? undefined,
    embeddingProvider: (row.embedding_provider as "none" | "gemini" | null) ?? undefined,
    embeddingModel: row.embedding_model ?? undefined,
    embeddingDimensions: row.embedding_dimensions ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

function buildRetrievalText(input: { timestampSec: number; ocrText?: string; visualDescription?: string }): string {
  const parts = [
    `timestamp ${formatTimestamp(input.timestampSec)}`,
    input.ocrText ? `ocr ${input.ocrText}` : undefined,
    input.visualDescription ? `scene ${input.visualDescription}` : undefined,
  ].filter(Boolean);
  return parts.join(". ");
}

function scoreFrameAgainstQuery(params: {
  query: string;
  rawQuery: string;
  frame: VisualIndexRecord;
  semanticQueryEmbedding?: number[];
}): SearchVisualMatch {
  const { query, rawQuery, frame, semanticQueryEmbedding } = params;
  const tokens = tokenize(query);
  const ocr = normalizeText(frame.ocrText);
  const description = normalizeText(frame.visualDescription);
  const retrievalText = normalizeText(frame.retrievalText ?? `${frame.ocrText ?? ""} ${frame.visualDescription ?? ""}`);
  const matchedOn: Array<"ocr" | "description" | "semantic"> = [];
  const evidenceNotes: string[] = [];

  let lexicalScore = 0;
  if (ocr) {
    const ocrScore = scoreField(query, tokens, ocr, 1.0);
    if (ocrScore > 0) {
      lexicalScore += ocrScore;
      matchedOn.push("ocr");
      evidenceNotes.push(`OCR matched: ${truncate(frame.ocrText ?? "", 120)}`);
    }
  }
  if (description) {
    const descriptionScore = scoreField(query, tokens, description, 1.25);
    if (descriptionScore > 0) {
      lexicalScore += descriptionScore;
      matchedOn.push("description");
      evidenceNotes.push(`Visual description matched: ${truncate(frame.visualDescription ?? "", 140)}`);
    }
  }
  lexicalScore = Math.min(1, lexicalScore / 2.8);

  let semanticScore: number | undefined;
  if (semanticQueryEmbedding && frame.textEmbedding && frame.textEmbedding.length === semanticQueryEmbedding.length) {
    semanticScore = Math.max(0, cosineSimilarity(semanticQueryEmbedding, frame.textEmbedding));
    if (semanticScore > 0.18) {
      matchedOn.push("semantic");
      evidenceNotes.push(`Gemini semantic retrieval matched frame text: ${truncate(frame.retrievalText ?? "", 140)}`);
    }
  }

  const combined = semanticScore !== undefined
    ? Math.min(1, (semanticScore * 0.72) + (lexicalScore * 0.28) + (matchedOn.includes("ocr") ? 0.03 : 0))
    : lexicalScore;

  if (evidenceNotes.length === 0 && retrievalText.includes(query)) {
    evidenceNotes.push(`Frame retrieval text matched: ${truncate(frame.retrievalText ?? "", 140)}`);
  }

  return {
    score: round(combined, 4),
    lexicalScore: round(lexicalScore, 4),
    semanticScore: semanticScore !== undefined ? round(semanticScore, 4) : undefined,
    matchedOn: Array.from(new Set(matchedOn)),
    videoId: frame.videoId,
    sourceVideoUrl: frame.sourceVideoUrl,
    sourceVideoTitle: frame.sourceVideoTitle,
    frameAssetId: frame.frameAssetId,
    framePath: frame.framePath,
    timestampSec: frame.timestampSec,
    timestampLabel: formatTimestamp(frame.timestampSec),
    explanation: evidenceNotes.join(" • ") || `No match signals found for '${rawQuery}'.`,
    ocrText: frame.ocrText,
    visualDescription: frame.visualDescription,
  };
}

function scoreField(query: string, tokens: string[], text: string, weight: number): number {
  let score = 0;
  if (text.includes(query)) {
    score += 1.3 * weight;
  }
  let matchedTokens = 0;
  for (const token of tokens) {
    if (text.includes(token)) {
      matchedTokens += 1;
      score += (token.length >= 5 ? 0.3 : 0.16) * weight;
    }
  }
  if (matchedTokens >= 2) score += 0.18 * weight;
  return score;
}

function summarizeDescriptionProvider(frames: VisualIndexRecord[]): "none" | "gemini" | "mixed" {
  const withDescriptions = frames.filter((frame) => Boolean(frame.visualDescription));
  if (withDescriptions.length === 0) return "none";
  if (withDescriptions.length === frames.length) return "gemini";
  return "mixed";
}

function summarizeEmbeddingProvider(frames: VisualIndexRecord[]): {
  provider: "none" | "gemini" | "mixed";
  model?: string;
  dimensions?: number;
} {
  const withEmbeddings = frames.filter((frame) => Boolean(frame.textEmbedding?.length));
  if (withEmbeddings.length === 0) return { provider: "none" };
  const first = withEmbeddings[0];
  if (withEmbeddings.length === frames.length) {
    return {
      provider: "gemini",
      model: first?.embeddingModel,
      dimensions: first?.embeddingDimensions,
    };
  }
  return {
    provider: "mixed",
    model: first?.embeddingModel,
    dimensions: first?.embeddingDimensions,
  };
}

function resolveGeminiEmbeddingSelection(includeGeminiEmbeddings?: boolean): EmbeddingSelection | null {
  const wantsEmbeddings = includeGeminiEmbeddings ?? true;
  if (!wantsEmbeddings) return null;
  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) return null;
  return resolveEmbeddingSelection({ embeddingProvider: "gemini" });
}

function buildIndexLimitations(descriptionProvider: "none" | "gemini", embeddingProvider: "none" | "gemini"): string[] {
  const limitations = [
    "This indexes video frames, not transcript chunks. Results are grounded in extracted frame images.",
    "Frames are sampled at intervals, so extremely brief visual moments can still be missed.",
    "Apple Vision feature prints are for image-to-image similarity, not language understanding.",
  ];
  if (descriptionProvider === "gemini") {
    limitations.push("Gemini 2.5 Flash is used to describe frame imagery in plain text when available.");
  } else {
    limitations.push("Without Gemini frame descriptions, non-text scene understanding is limited.");
  }
  if (embeddingProvider === "gemini") {
    limitations.push("Semantic text→visual retrieval uses Gemini embeddings over OCR/description text, not direct image embeddings.");
  } else {
    limitations.push("Gemini embeddings were not available, so semantic text→visual retrieval falls back to lexical OCR/description matching.");
  }
  return limitations;
}

function buildSearchLimitations(descriptionProvider: "none" | "gemini" | "mixed", embeddingProvider: "none" | "gemini" | "mixed"): string[] {
  const limitations = [
    "Search is visual-index based. It does not reuse transcript embeddings.",
    "Every match is backed by a local frame path and timestamp so the calling LLM can inspect the actual evidence.",
    "Apple Vision feature-print similarity is separate from semantic retrieval and should be treated as exact visual similarity, not language search.",
  ];
  if (descriptionProvider === "none") {
    limitations.push("Without Gemini frame descriptions, search is strongest on visible on-screen text, slides, UIs, and screenshots.");
  } else {
    limitations.push("Gemini frame descriptions improve scene search, but the source evidence remains the returned frame image on disk.");
  }
  if (embeddingProvider === "none") {
    limitations.push("This index has no Gemini embedding layer, so search is lexical over OCR/description text only.");
  } else {
    limitations.push("Semantic text→visual retrieval uses Gemini embeddings over OCR/description text, not native multimodal image embeddings.");
  }
  return limitations;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return Array.from(new Set(value.split(" ").filter((token) => token.length >= 2)));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatTimestamp(value: number): string {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    magA += a[index]! * a[index]!;
    magB += b[index]! * b[index]!;
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  if (!Number.isFinite(denominator) || denominator <= 1e-9) return 0;
  return dot / denominator;
}

function normalizeVector(values: number[] | undefined): number[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const finite = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  const magnitude = Math.sqrt(finite.reduce((sum, value) => sum + (value * value), 0));
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) return finite;
  return finite.map((value) => value / magnitude);
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
