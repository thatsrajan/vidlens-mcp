import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { buildChapterTranscriptSegments, summarizeText } from "./analysis.js";
import {
  createEmbeddingProvider,
  embeddingSelectionLabel,
  parseAlgorithmSelection,
  selectionToAlgorithm,
  type EmbeddingSelection,
} from "./embedding-provider.js";
import { buildVideoUrl } from "./id-parsing.js";
import type {
  ClearActiveCollectionOutput,
  CollectionScopeMeta,
  CollectionSummary,
  ImportPlaylistOutput,
  ImportVideosOutput,
  ListCollectionsOutput,
  PlaylistKnowledgeBaseInput,
  Provenance,
  RemoveCollectionOutput,
  SearchTranscriptsInput,
  SearchTranscriptsOutput,
  SetActiveCollectionOutput,
  TranscriptRecord,
  TranscriptSegment,
  VideoRecord,
  VideoKnowledgeBaseInput,
} from "./types.js";

const DEFAULT_LOCAL_EMBEDDING_MODEL = "local-lsa-hybrid-v1 (TF-IDF + latent semantic projection, no external model)";
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have",
  "how", "if", "in", "into", "is", "it", "its", "just", "more", "most", "not", "of", "on", "or", "our",
  "that", "the", "their", "there", "these", "they", "this", "those", "to", "too", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

interface KnowledgeBaseConfig {
  dataDir?: string;
}

export interface CollectionSeed {
  collectionId: string;
  label?: string;
  sourceType: "playlist" | "videos";
  sourceRef?: string;
  sourceTitle?: string;
  sourceChannelTitle?: string;
  embeddingSelection?: EmbeddingSelection;
}

export interface ImportTranscriptItem {
  video: VideoRecord;
  transcript: TranscriptRecord;
  options: {
    strategy: "auto" | "chapters" | "time_window";
    chunkSizeSec: number;
    chunkOverlapSec: number;
  };
}

interface StoredChunk {
  chunkId: string;
  collectionId: string;
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  ordinal: number;
  tStartSec: number;
  tEndSec?: number;
  text: string;
  terms: Record<string, number>;
  docNorm: number;
  embedding: number[];
}

interface CollectionModel {
  algorithm: string;
  builtAt: string;
  chunkCount: number;
  sigma: number[];
  idf: Record<string, number>;
}

interface SearchRow {
  chunkId: string;
  collectionId: string;
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  ordinal: number;
  tStartSec: number;
  tEndSec?: number;
  text: string;
  termsJson: string;
  docNorm: number | null;
  embeddingJson: string | null;
}

function defaultDataDir(): string {
  return process.env.VIDLENS_DATA_DIR || join(homedir(), "Library", "Application Support", "vidlens-mcp");
}

export class TranscriptKnowledgeBase {
  private readonly db: DatabaseSync;
  readonly dataDir: string;

  constructor(config: KnowledgeBaseConfig = {}) {
    this.dataDir = config.dataDir ?? defaultDataDir();
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, "knowledge-base.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        collection_id TEXT PRIMARY KEY,
        label TEXT,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        source_title TEXT,
        source_channel_title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collection_videos (
        collection_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        title TEXT,
        channel_title TEXT,
        published_at TEXT,
        transcript_language TEXT,
        transcript_source_type TEXT,
        url TEXT,
        transcript_characters INTEGER,
        transcript_segments INTEGER,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, video_id),
        FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS transcript_chunks (
        chunk_id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        t_start_sec REAL NOT NULL,
        t_end_sec REAL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        terms_json TEXT NOT NULL,
        doc_norm REAL,
        embedding_json TEXT,
        FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS collection_models (
        collection_id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        sigma_json TEXT NOT NULL,
        idf_json TEXT NOT NULL,
        built_at TEXT NOT NULL,
        FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  ensureCollection(seed: CollectionSeed): { collectionId: string; created: boolean } {
    const existing = this.db
      .prepare("SELECT collection_id FROM collections WHERE collection_id = ?")
      .get(seed.collectionId) as { collection_id: string } | undefined;
    const now = new Date().toISOString();

    if (existing) {
      this.db
        .prepare(`
          UPDATE collections
          SET label = COALESCE(?, label),
              source_ref = COALESCE(?, source_ref),
              source_title = COALESCE(?, source_title),
              source_channel_title = COALESCE(?, source_channel_title),
              updated_at = ?
          WHERE collection_id = ?
        `)
        .run(seed.label ?? null, seed.sourceRef ?? null, seed.sourceTitle ?? null, seed.sourceChannelTitle ?? null, now, seed.collectionId);
      return { collectionId: seed.collectionId, created: false };
    }

    this.db
      .prepare(`
        INSERT INTO collections (
          collection_id, label, source_type, source_ref, source_title, source_channel_title, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        seed.collectionId,
        seed.label ?? null,
        seed.sourceType,
        seed.sourceRef ?? null,
        seed.sourceTitle ?? null,
        seed.sourceChannelTitle ?? null,
        now,
        now,
      );

    return { collectionId: seed.collectionId, created: true };
  }

  hasVideo(collectionId: string, videoId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM collection_videos WHERE collection_id = ? AND video_id = ?")
      .get(collectionId, videoId) as { 1: number } | undefined;
    return Boolean(row);
  }

  deleteVideo(collectionId: string, videoId: string): void {
    this.db.prepare("DELETE FROM transcript_chunks WHERE collection_id = ? AND video_id = ?").run(collectionId, videoId);
    this.db.prepare("DELETE FROM collection_videos WHERE collection_id = ? AND video_id = ?").run(collectionId, videoId);
  }

  importPlaylist(
    seed: CollectionSeed,
    playlist: ImportPlaylistOutput["playlist"],
    items: ImportTranscriptItem[],
  ): ImportPlaylistOutput {
    this.ensureCollection({
      ...seed,
      sourceType: "playlist",
      sourceRef: playlist.playlistId,
      sourceTitle: playlist.title,
      sourceChannelTitle: playlist.channelTitle,
    });

    const stats = this.persistItems(seed.collectionId, items);
    return {
      playlist,
      import: stats.import,
      failures: stats.failures.length > 0 ? stats.failures : undefined,
      collectionId: seed.collectionId,
      provenance: localProvenance(),
    };
  }

  importVideos(seed: CollectionSeed, items: ImportTranscriptItem[]): ImportVideosOutput {
    this.ensureCollection(seed);
    const stats = this.persistItems(seed.collectionId, items);
    return {
      import: stats.import,
      failures: stats.failures.length > 0 ? stats.failures : undefined,
      collectionId: seed.collectionId,
      provenance: localProvenance(),
    };
  }

  listCollections(includeVideoList = false): ListCollectionsOutput {
    const rows = this.db.prepare(`
      SELECT
        c.collection_id,
        c.label,
        c.source_type,
        c.source_ref,
        c.source_title,
        c.source_channel_title,
        c.created_at,
        c.updated_at,
        (SELECT algorithm FROM collection_models m WHERE m.collection_id = c.collection_id) AS algorithm,
        COALESCE((SELECT COUNT(*) FROM collection_videos v WHERE v.collection_id = c.collection_id), 0) AS video_count,
        COALESCE((SELECT COUNT(*) FROM transcript_chunks ch WHERE ch.collection_id = c.collection_id), 0) AS total_chunks
      FROM collections c
      ORDER BY c.updated_at DESC, c.collection_id ASC
    `).all() as Array<{
      collection_id: string;
      label: string | null;
      source_type: string;
      source_ref: string | null;
      source_title: string | null;
      source_channel_title: string | null;
      created_at: string;
      updated_at: string;
      algorithm: string | null;
      video_count: number;
      total_chunks: number;
    }>;

    const activeCollectionId = this.getActiveCollectionId();
    const videoMap = includeVideoList ? this.loadVideosForCollections(rows.map((row) => row.collection_id)) : new Map<string, CollectionSummary["videos"]>();

    return {
      collections: rows.map((row) => {
        const selection = parseAlgorithmSelection(row.algorithm ?? "local-lsa-hybrid-v1");
        return {
          collectionId: row.collection_id,
          label: row.label ?? undefined,
          sourceType: row.source_type as CollectionSummary["sourceType"],
          sourcePlaylistId: row.source_type === "playlist" ? row.source_ref ?? undefined : undefined,
          sourceTitle: row.source_title ?? undefined,
          sourceChannelTitle: row.source_channel_title ?? undefined,
          videoCount: Number(row.video_count ?? 0),
          totalChunks: Number(row.total_chunks ?? 0),
          createdAt: row.created_at,
          lastUpdatedAt: row.updated_at,
          embeddingProvider: selection.kind,
          embeddingModel: selection.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL,
          embeddingDimensions: selection.dimensions,
          isActive: row.collection_id === activeCollectionId,
          videos: videoMap.get(row.collection_id),
        };
      }),
      activeCollectionId: activeCollectionId ?? undefined,
      provenance: localProvenance(),
    };
  }

  setActiveCollection(collectionId: string): SetActiveCollectionOutput {
    const collection = this.getCollectionSummary(collectionId);
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`);
    }

    this.setAppState("active_collection_id", collectionId);
    return {
      activeCollectionId: collectionId,
      collection: {
        ...collection,
        isActive: true,
      },
      provenance: localProvenance(),
    };
  }

  clearActiveCollection(): ClearActiveCollectionOutput {
    const previousActiveCollectionId = this.getActiveCollectionId();
    this.deleteAppState("active_collection_id");
    return {
      cleared: Boolean(previousActiveCollectionId),
      previousActiveCollectionId: previousActiveCollectionId ?? undefined,
      provenance: localProvenance(),
    };
  }

  getActiveCollectionId(): string | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get("active_collection_id") as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  removeCollection(collectionId: string): RemoveCollectionOutput {
    const chunkRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_chunks WHERE collection_id = ?")
      .get(collectionId) as { count: number } | undefined;
    const existing = this.db
      .prepare("SELECT 1 FROM collections WHERE collection_id = ?")
      .get(collectionId) as { 1: number } | undefined;

    if (!existing) {
      return {
        removed: false,
        collectionId,
        chunksDeleted: 0,
        videosDeleted: 0,
        clearedActiveCollection: false,
        provenance: localProvenance(),
      };
    }

    const wasActive = this.getActiveCollectionId() === collectionId;
    const videoRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM collection_videos WHERE collection_id = ?")
      .get(collectionId) as { count: number } | undefined;
    this.db.prepare("DELETE FROM collections WHERE collection_id = ?").run(collectionId);
    if (wasActive) {
      this.deleteAppState("active_collection_id");
    }

    return {
      removed: true,
      collectionId,
      chunksDeleted: Number(chunkRow?.count ?? 0),
      videosDeleted: Number(videoRow?.count ?? 0),
      clearedActiveCollection: wasActive,
      provenance: localProvenance(),
    };
  }

  async reindexCollectionEmbeddings(collectionId: string, selection: EmbeddingSelection): Promise<void> {
    if (selection.kind === "local") {
      this.rebuildCollectionModel(collectionId);
      return;
    }

    const model = this.loadModel(collectionId);
    const rows = this.loadSearchRows(collectionId);
    if (!model || rows.length === 0) {
      return;
    }

    const provider = await createEmbeddingProvider(selection);
    if (!provider) {
      return;
    }
    const embeddings = await provider.embedDocuments(rows.map((row) => row.text));
    if (embeddings.length !== rows.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} vectors for ${rows.length} chunks.`);
    }

    const updateChunk = this.db.prepare(`
      UPDATE transcript_chunks
      SET doc_norm = ?, embedding_json = ?
      WHERE chunk_id = ?
    `);

    this.db.exec("BEGIN");
    try {
      rows.forEach((row, index) => {
        const embedding = embeddings[index] ?? [];
        updateChunk.run(magnitudeOf(embedding) || 1, JSON.stringify(embedding), row.chunkId);
      });
      this.db.prepare(`
        UPDATE collection_models
        SET algorithm = ?, sigma_json = ?, built_at = ?
        WHERE collection_id = ?
      `).run(
        selectionToAlgorithm(selection),
        JSON.stringify([]),
        new Date().toISOString(),
        collectionId,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async search(input: SearchTranscriptsInput): Promise<SearchTranscriptsOutput> {
    const startedAt = Date.now();
    const maxResults = Math.max(1, Math.min(input.maxResults ?? 10, 50));
    const minScore = Math.max(0, Math.min(input.minScore ?? 0.2, 1));
    const scope = this.resolveCollectionScope(input);
    const targetCollections = scope.searchedCollectionIds;
    const videoFilter = input.videoIdFilter ? new Set(input.videoIdFilter) : undefined;
    const results: SearchTranscriptsOutput["results"] = [];
    let totalChunksSearched = 0;
    let embeddingModelLabel = DEFAULT_LOCAL_EMBEDDING_MODEL;
    let semanticFallback = false;

    for (const collectionId of targetCollections) {
      const model = this.loadModel(collectionId);
      if (!model || model.chunkCount === 0) {
        continue;
      }
      const rows = this.loadSearchRows(collectionId, videoFilter);
      if (rows.length === 0) {
        continue;
      }
      totalChunksSearched += rows.length;
      embeddingModelLabel = humanizeAlgorithm(model.algorithm);
      const rankedResult = await rankCollection(rows, model, input.query);
      const ranked = rankedResult.rows;
      semanticFallback ||= rankedResult.semanticFallback;
      const byVideo = groupChunkContexts(rows);

      for (const row of ranked) {
        if (row.score < minScore) {
          continue;
        }
        const context = byVideo.get(row.videoId);
        const previous = context?.get(row.ordinal - 1);
        const next = context?.get(row.ordinal + 1);
        results.push({
          collectionId,
          videoId: row.videoId,
          videoTitle: row.videoTitle,
          channelTitle: row.channelTitle,
          chunkText: row.text,
          tStartSec: row.tStartSec,
          tEndSec: row.tEndSec,
          timestampUrl: buildTimestampUrl(row.videoId, row.tStartSec),
          score: round(row.score, 4),
          lexicalScore: round(row.lexicalScore, 4),
          semanticScore: row.semanticScore !== undefined ? round(row.semanticScore, 4) : undefined,
          context: {
            prevChunkText: previous?.text,
            nextChunkText: next?.text,
          },
        });
      }
    }

    const deduped = results
      .sort((a, b) => b.score - a.score || a.videoTitle.localeCompare(b.videoTitle))
      .slice(0, maxResults);

    return {
      query: input.query,
      results: deduped,
      searchMeta: {
        totalChunksSearched,
        embeddingModel: semanticFallback ? `${embeddingModelLabel} (lexical fallback for this query)` : embeddingModelLabel,
        searchLatencyMs: Date.now() - startedAt,
        scope,
      },
      provenance: localProvenance(),
    };
  }

  static playlistCollectionId(playlistId: string): string {
    return `playlist-${playlistId}`;
  }

  static videosCollectionId(input: VideoKnowledgeBaseInput): string {
    if (input.collectionId) {
      return input.collectionId;
    }
    const labelPart = slugify(input.label ?? "videos");
    const fingerprint = createHash("sha1").update(input.videoIdsOrUrls.join("\n")).digest("hex").slice(0, 8);
    return `videos-${labelPart}-${fingerprint}`;
  }

  close(): void {
    this.db.close();
  }

  private persistItems(collectionId: string, items: ImportTranscriptItem[]): {
    import: ImportVideosOutput["import"];
    failures: Array<{ videoId: string; reason: string }>;
  } {
    const failures: Array<{ videoId: string; reason: string }> = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let chunksCreated = 0;
    const allItems = items.length;

    const insertVideo = this.db.prepare(`
      INSERT OR REPLACE INTO collection_videos (
        collection_id, video_id, title, channel_title, published_at, transcript_language, transcript_source_type, url,
        transcript_characters, transcript_segments, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO transcript_chunks (
        chunk_id, collection_id, video_id, ordinal, t_start_sec, t_end_sec, text, token_count, terms_json, doc_norm, embedding_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        try {
          this.deleteVideo(collectionId, item.video.videoId);
          const chunks = chunkTranscript(item.transcript, item.options);
          if (chunks.length === 0) {
            throw new Error("Transcript could not be chunked into searchable segments.");
          }
          const now = new Date().toISOString();
          insertVideo.run(
            collectionId,
            item.video.videoId,
            item.video.title,
            item.video.channelTitle,
            item.video.publishedAt ?? null,
            item.transcript.languageUsed ?? null,
            item.transcript.sourceType,
            item.video.url || buildVideoUrl(item.video.videoId),
            item.transcript.transcriptText.length,
            item.transcript.segments.length,
            now,
          );

          chunks.forEach((chunk, index) => {
            insertChunk.run(
              randomUUID(),
              collectionId,
              item.video.videoId,
              index,
              chunk.tStartSec,
              chunk.tEndSec ?? null,
              chunk.text,
              chunk.tokenCount,
              JSON.stringify(chunk.terms),
              null,
              null,
            );
          });

          imported += 1;
          chunksCreated += chunks.length;
        } catch (error) {
          failed += 1;
          failures.push({
            videoId: item.video.videoId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (imported > 0) {
      this.rebuildCollectionModel(collectionId);
      this.touchCollection(collectionId);
    }

    skipped = allItems - imported - failed;
    return {
      import: {
        totalVideos: allItems,
        imported,
        skipped,
        failed,
        chunksCreated,
        embeddingsGenerated: chunksCreated,
      },
      failures,
    };
  }

  private rebuildCollectionModel(collectionId: string): void {
    const rows = this.loadSearchRows(collectionId);
    if (rows.length === 0) {
      this.db.prepare("DELETE FROM collection_models WHERE collection_id = ?").run(collectionId);
      return;
    }

    const documents = rows.map((row) => ({
      row,
      terms: safeParseCounts(row.termsJson),
    }));
    const idf = buildIdfMap(documents.map((item) => item.terms));
    const normalizedDocs = documents.map((item) => {
      const normalized = buildNormalizedVector(item.terms, idf);
      return {
        ...item,
        normalized,
        norm: vectorNorm(normalized),
      };
    });

    const similarity = buildSimilarityMatrix(normalizedDocs.map((item) => item.normalized));
    const decomposition = decomposeSimilarity(similarity, Math.min(12, normalizedDocs.length));

    const updateChunk = this.db.prepare(`
      UPDATE transcript_chunks
      SET doc_norm = ?, embedding_json = ?
      WHERE chunk_id = ?
    `);

    this.db.exec("BEGIN");
    try {
      normalizedDocs.forEach((item, index) => {
        const embedding = decomposition.embeddings[index] ?? [];
        updateChunk.run(item.norm, JSON.stringify(embedding), item.row.chunkId);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO collection_models (collection_id, algorithm, chunk_count, sigma_json, idf_json, built_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      collectionId,
      selectionToAlgorithm({ kind: "local" }),
      normalizedDocs.length,
      JSON.stringify(decomposition.sigma),
      JSON.stringify(idf),
      new Date().toISOString(),
    );
  }

  private listCollectionIds(): string[] {
    return (this.db.prepare("SELECT collection_id FROM collections ORDER BY updated_at DESC, collection_id ASC").all() as Array<{ collection_id: string }>).map((row) => row.collection_id);
  }

  private resolveCollectionScope(input: SearchTranscriptsInput): CollectionScopeMeta {
    if (input.collectionId) {
      return {
        mode: "explicit",
        activeCollectionId: this.getActiveCollectionId() ?? undefined,
        searchedCollectionIds: [input.collectionId],
      };
    }

    const activeCollectionId = this.getActiveCollectionId();
    if ((input.useActiveCollection ?? true) && activeCollectionId) {
      return {
        mode: "active",
        activeCollectionId,
        searchedCollectionIds: [activeCollectionId],
      };
    }

    return {
      mode: "all_collections",
      activeCollectionId: activeCollectionId ?? undefined,
      searchedCollectionIds: this.listCollectionIds(),
    };
  }

  private getCollectionSummary(collectionId: string): CollectionSummary | null {
    const all = this.listCollections(true);
    return all.collections.find((collection) => collection.collectionId === collectionId) ?? null;
  }

  private setAppState(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run(key, value, new Date().toISOString());
  }

  private deleteAppState(key: string): void {
    this.db.prepare("DELETE FROM app_state WHERE key = ?").run(key);
  }

  private loadSearchRows(collectionId: string, videoFilter?: Set<string>): SearchRow[] {
    const rows = this.db.prepare(`
      SELECT
        ch.chunk_id,
        ch.collection_id,
        ch.video_id,
        v.title AS video_title,
        v.channel_title,
        ch.ordinal,
        ch.t_start_sec,
        ch.t_end_sec,
        ch.text,
        ch.terms_json,
        ch.doc_norm,
        ch.embedding_json
      FROM transcript_chunks ch
      INNER JOIN collection_videos v
        ON v.collection_id = ch.collection_id AND v.video_id = ch.video_id
      WHERE ch.collection_id = ?
      ORDER BY ch.video_id ASC, ch.ordinal ASC
    `).all(collectionId) as Array<{
      chunk_id: string;
      collection_id: string;
      video_id: string;
      video_title: string | null;
      channel_title: string | null;
      ordinal: number;
      t_start_sec: number;
      t_end_sec: number | null;
      text: string;
      terms_json: string;
      doc_norm: number | null;
      embedding_json: string | null;
    }>;

    return rows
      .filter((row) => !videoFilter || videoFilter.has(row.video_id))
      .map((row) => ({
        chunkId: row.chunk_id,
        collectionId: row.collection_id,
        videoId: row.video_id,
        videoTitle: row.video_title ?? row.video_id,
        channelTitle: row.channel_title ?? "Unknown channel",
        ordinal: Number(row.ordinal),
        tStartSec: Number(row.t_start_sec),
        tEndSec: row.t_end_sec === null ? undefined : Number(row.t_end_sec),
        text: row.text,
        termsJson: row.terms_json,
        docNorm: row.doc_norm,
        embeddingJson: row.embedding_json,
      }));
  }

  private loadVideosForCollections(collectionIds: string[]): Map<string, CollectionSummary["videos"]> {
    const map = new Map<string, CollectionSummary["videos"]>();
    if (collectionIds.length === 0) {
      return map;
    }

    const placeholders = collectionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT collection_id, video_id, title, channel_title, published_at
      FROM collection_videos
      WHERE collection_id IN (${placeholders})
      ORDER BY collection_id ASC, imported_at DESC, video_id ASC
    `).all(...collectionIds) as Array<{
      collection_id: string;
      video_id: string;
      title: string | null;
      channel_title: string | null;
      published_at: string | null;
    }>;

    for (const row of rows) {
      const existing = map.get(row.collection_id) ?? [];
      existing.push({
        videoId: row.video_id,
        title: row.title ?? undefined,
        channelTitle: row.channel_title ?? undefined,
        publishedAt: row.published_at ?? undefined,
      });
      map.set(row.collection_id, existing);
    }

    return map;
  }

  private loadModel(collectionId: string): CollectionModel | null {
    const row = this.db.prepare(`
      SELECT algorithm, chunk_count, sigma_json, idf_json, built_at
      FROM collection_models
      WHERE collection_id = ?
    `).get(collectionId) as {
      algorithm: string;
      chunk_count: number;
      sigma_json: string;
      idf_json: string;
      built_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      algorithm: row.algorithm,
      chunkCount: Number(row.chunk_count),
      sigma: safeParseNumberArray(row.sigma_json),
      idf: safeParseNumberMap(row.idf_json),
      builtAt: row.built_at,
    };
  }

  private touchCollection(collectionId: string): void {
    this.db.prepare("UPDATE collections SET updated_at = ? WHERE collection_id = ?").run(new Date().toISOString(), collectionId);
  }
}

function chunkTranscript(
  transcript: TranscriptRecord,
  options: { strategy: "auto" | "chapters" | "time_window"; chunkSizeSec: number; chunkOverlapSec: number },
): Array<{ tStartSec: number; tEndSec?: number; text: string; terms: Record<string, number>; tokenCount: number }> {
  const strategy = options.strategy === "auto"
    ? ((transcript.chapters?.length ?? 0) >= 2 ? "chapters" : "time_window")
    : options.strategy;

  const rawChunks = strategy === "chapters"
    ? chunkByChapter(transcript)
    : chunkByWindow(transcript, options.chunkSizeSec, options.chunkOverlapSec);

  const filtered = rawChunks
    .map((chunk) => {
      const text = chunk.text.replace(/\s+/g, " ").trim();
      const terms = buildTermCounts(text);
      const tokenCount = Object.values(terms).reduce((sum, count) => sum + count, 0);
      return {
        tStartSec: chunk.tStartSec,
        tEndSec: chunk.tEndSec,
        text,
        terms,
        tokenCount,
      };
    })
    .filter((chunk) => chunk.text.length >= 40 && chunk.tokenCount >= 5);

  if (filtered.length > 0) {
    return filtered;
  }

  const fallbackText = transcript.transcriptText.replace(/\s+/g, " ").trim();
  const fallbackTerms = buildTermCounts(fallbackText);
  const fallbackTokenCount = Object.values(fallbackTerms).reduce((sum, count) => sum + count, 0);
  if (fallbackText.length > 0 && fallbackTokenCount > 0) {
    return [{
      tStartSec: transcript.segments[0]?.tStartSec ?? 0,
      tEndSec: transcript.segments[transcript.segments.length - 1]?.tEndSec,
      text: fallbackText,
      terms: fallbackTerms,
      tokenCount: fallbackTokenCount,
    }];
  }

  return filtered;
}

function chunkByChapter(transcript: TranscriptRecord): TranscriptSegment[] {
  const chapterSegments = buildChapterTranscriptSegments(transcript);
  return chapterSegments.length > 0
    ? chapterSegments
    : chunkByWindow(transcript, 120, 30);
}

function chunkByWindow(transcript: TranscriptRecord, chunkSizeSec: number, chunkOverlapSec: number): TranscriptSegment[] {
  if (transcript.segments.length === 0) {
    if (!transcript.transcriptText.trim()) {
      return [];
    }
    return [{
      tStartSec: 0,
      tEndSec: undefined,
      text: transcript.transcriptText,
    }];
  }

  const chunks: TranscriptSegment[] = [];
  const stepSec = Math.max(10, chunkSizeSec - chunkOverlapSec);
  const lastEnd = transcript.segments[transcript.segments.length - 1]?.tEndSec ?? transcript.segments[transcript.segments.length - 1]?.tStartSec ?? 0;

  for (let windowStart = transcript.segments[0]?.tStartSec ?? 0; windowStart <= lastEnd; windowStart += stepSec) {
    const windowEnd = windowStart + chunkSizeSec;
    const members = transcript.segments.filter((segment) => {
      const segmentEnd = segment.tEndSec ?? segment.tStartSec;
      return segment.tStartSec < windowEnd && segmentEnd >= windowStart;
    });
    if (members.length === 0) {
      continue;
    }
    const text = members.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim();
    const uniqueKey = `${Math.floor(members[0]?.tStartSec ?? windowStart)}-${Math.floor(members[members.length - 1]?.tEndSec ?? windowEnd)}-${text.slice(0, 24)}`;
    if (chunks.some((chunk) => `${Math.floor(chunk.tStartSec)}-${Math.floor(chunk.tEndSec ?? 0)}-${chunk.text.slice(0, 24)}` === uniqueKey)) {
      continue;
    }
    chunks.push({
      tStartSec: members[0]?.tStartSec ?? windowStart,
      tEndSec: members[members.length - 1]?.tEndSec ?? members[members.length - 1]?.tStartSec ?? windowEnd,
      text,
      topicLabel: summarizeText(text, 1),
    });
  }

  return chunks;
}

function buildTermCounts(text: string): Record<string, number> {
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

function tokenize(text: string): string[] {
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

function stem(token: string): string {
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

function buildIdfMap(documents: Array<Record<string, number>>): Record<string, number> {
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

function buildNormalizedVector(terms: Record<string, number>, idf: Record<string, number>): Record<string, number> {
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

function buildSimilarityMatrix(vectors: Array<Record<string, number>>): Float64Array {
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

function decomposeSimilarity(matrix: Float64Array, size: number): { sigma: number[]; embeddings: number[][] } {
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

async function rankCollection(
  rows: SearchRow[],
  model: CollectionModel,
  query: string,
): Promise<{ rows: Array<StoredChunk & { score: number; lexicalScore: number; semanticScore?: number }>; semanticFallback: boolean }> {
  const queryTerms = buildTermCounts(query);
  const queryVector = buildNormalizedVector(queryTerms, model.idf);
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm <= 0) {
    return { rows: [], semanticFallback: false };
  }

  const chunks: StoredChunk[] = rows.map((row) => ({
    chunkId: row.chunkId,
    collectionId: row.collectionId,
    videoId: row.videoId,
    videoTitle: row.videoTitle,
    channelTitle: row.channelTitle,
    ordinal: row.ordinal,
    tStartSec: row.tStartSec,
    tEndSec: row.tEndSec,
    text: row.text,
    terms: safeParseCounts(row.termsJson),
    docNorm: Number(row.docNorm ?? 1),
    embedding: safeParseNumberArray(row.embeddingJson),
  }));

  const lexicalScores = chunks.map((chunk) => lexicalSimilarity(chunk.terms, chunk.docNorm, queryVector, queryNorm, model.idf));
  const selection = parseAlgorithmSelection(model.algorithm);

  let semanticScores: Array<number | undefined> = [];
  let semanticFallback = false;

  if (selection.kind === "gemini" && chunks.some((chunk) => chunk.embedding.length > 0)) {
    try {
      const provider = await createEmbeddingProvider(selection);
      if (provider) {
        const queryEmbedding = await provider.embedQuery(query);
        semanticScores = cosineSimilarities(chunks, queryEmbedding);
      }
    } catch {
      semanticFallback = true;
    }
  } else {
    const hasEmbedding = model.sigma.length > 0 && chunks.some((chunk) => chunk.embedding.length > 0);
    semanticScores = hasEmbedding ? semanticSimilarities(chunks, lexicalScores, model.sigma) : [];
  }

  return {
    semanticFallback,
    rows: chunks
      .map((chunk, index) => {
        const lexicalScore = lexicalScores[index] ?? 0;
        const semanticScore = semanticScores[index];
        const combined = semanticScore === undefined
          ? lexicalScore
          : (lexicalScore * 0.35) + (Math.max(semanticScore, 0) * 0.65);
        return {
          ...chunk,
          lexicalScore,
          semanticScore,
          score: combined,
        };
      })
      .sort((a, b) => b.score - a.score || b.lexicalScore - a.lexicalScore || a.ordinal - b.ordinal),
  };
}

function lexicalSimilarity(
  docTerms: Record<string, number>,
  _docNorm: number,
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

function semanticSimilarities(chunks: StoredChunk[], lexicalScores: number[], sigma: number[]): Array<number | undefined> {
  const queryEmbedding = Array.from({ length: sigma.length }, () => 0);
  for (let index = 0; index < chunks.length; index += 1) {
    const lexicalScore = lexicalScores[index] ?? 0;
    if (lexicalScore <= 0) {
      continue;
    }
    const embedding = chunks[index].embedding;
    for (let component = 0; component < sigma.length; component += 1) {
      const divisor = sigma[component] ** 2 || 1;
      queryEmbedding[component] += lexicalScore * ((embedding[component] ?? 0) / divisor);
    }
  }

  return cosineSimilarities(chunks, queryEmbedding);
}

function cosineSimilarities(chunks: StoredChunk[], queryEmbedding: number[]): Array<number | undefined> {
  const queryMagnitude = magnitudeOf(queryEmbedding);
  if (queryMagnitude <= 1e-9) {
    return chunks.map(() => undefined);
  }

  return chunks.map((chunk) => {
    const magnitude = magnitudeOf(chunk.embedding);
    if (magnitude <= 1e-9) {
      return undefined;
    }
    return dot(queryEmbedding, chunk.embedding) / (queryMagnitude * magnitude);
  });
}

function buildTimestampUrl(videoId: string, tStartSec: number): string {
  return `https://youtu.be/${videoId}?t=${Math.max(0, Math.floor(tStartSec))}`;
}

function humanizeAlgorithm(algorithm: string): string {
  const selection = parseAlgorithmSelection(algorithm);
  if (selection.kind === "gemini") {
    return `Gemini embeddings (${selection.model}, ${selection.dimensions}d)`;
  }
  return DEFAULT_LOCAL_EMBEDDING_MODEL;
}

function localProvenance(): Provenance {
  return {
    sourceTier: "none",
    fetchedAt: new Date().toISOString(),
    fallbackDepth: 3,
    partial: false,
    sourceNotes: ["Query served from the local transcript knowledge base."],
  };
}

function groupChunkContexts(rows: SearchRow[]): Map<string, Map<number, SearchRow>> {
  const grouped = new Map<string, Map<number, SearchRow>>();
  for (const row of rows) {
    const map = grouped.get(row.videoId) ?? new Map<number, SearchRow>();
    map.set(row.ordinal, row);
    grouped.set(row.videoId, map);
  }
  return grouped;
}

function safeParseCounts(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeParseNumberMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeParseNumberArray(value: string | null | undefined): number[] {
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

function vectorNorm(vector: Record<string, number>): number {
  return Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0));
}

function multiplyMatrixVector(matrix: Float64Array, size: number, vector: number[]): number[] {
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

function normalizeDense(values: number[]): number[] {
  const magnitude = magnitudeOf(values);
  if (magnitude <= 1e-9) {
    return values;
  }
  return values.map((value) => value / magnitude);
}

function magnitudeOf(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0));
}

function dot(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "collection";
}

export function resolveCollectionIdForPlaylist(input: PlaylistKnowledgeBaseInput): string {
  return input.collectionId ?? TranscriptKnowledgeBase.playlistCollectionId(input.playlistUrlOrId);
}
