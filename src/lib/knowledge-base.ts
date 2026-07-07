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
import { KNOWLEDGE_BASE_MIGRATIONS, runMigrations } from "./schema-migration.js";
import {
  buildIdfMap,
  buildLocalProvenance,
  buildNormalizedVector,
  buildSimilarityMatrix,
  buildTermCounts,
  cosineSimilarities,
  decomposeSimilarity,
  lexicalSimilarity,
  magnitudeOf,
  round,
  safeParseCounts,
  safeParseNumberArray,
  safeParseNumberMap,
  semanticSimilarities,
  slugify,
  vectorNorm,
} from "./text-math.js";
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
  sourcePlatform?: string;
  sourceId?: string;
  canonicalUrl?: string;
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
  sourcePlatform?: string;
  sourceId?: string;
  canonicalUrl?: string;
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
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
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
	        source_platform TEXT,
	        source_id TEXT,
	        canonical_url TEXT,
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
        chunk_type TEXT NOT NULL DEFAULT 'transcript',
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

      CREATE INDEX IF NOT EXISTS idx_transcript_chunks_collection_video_ordinal
        ON transcript_chunks(collection_id, video_id, ordinal);
	      CREATE INDEX IF NOT EXISTS idx_transcript_chunks_collection
	        ON transcript_chunks(collection_id);
	    `);
    this.addColumnIfMissing("collection_videos", "source_platform", "TEXT");
    this.addColumnIfMissing("collection_videos", "source_id", "TEXT");
    this.addColumnIfMissing("collection_videos", "canonical_url", "TEXT");
    this.db.exec(`
      UPDATE collection_videos
      SET source_platform = 'youtube'
      WHERE source_platform IS NULL;
    `);
    const rows = this.db.prepare("SELECT collection_id, video_id FROM collection_videos WHERE canonical_url IS NULL").all() as Array<{ collection_id: string; video_id: string }>;
    const updateCanonical = this.db.prepare("UPDATE collection_videos SET canonical_url = ? WHERE collection_id = ? AND video_id = ?");
    for (const row of rows) {
      updateCanonical.run(buildVideoUrl(row.video_id), row.collection_id, row.video_id);
    }
    // Apply versioned migrations after the base schema exists. Migrations are
    // guarded/idempotent (see schema-migration.ts) so this is safe on fresh DBs
    // (tables just created above, chunk_type already present) and legacy DBs
    // (chunk_type added by migration v2, PRAGMA user_version advanced).
    runMigrations(this.db, "knowledge-base.sqlite", KNOWLEDGE_BASE_MIGRATIONS);
	  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private inTransaction = false;

  /**
   * Run `fn` inside a single SQLite transaction. Reentrant: if a transaction is
   * already open (e.g. deleteVideo called from within persistItems), the body
   * runs inline under the existing transaction rather than issuing a nested
   * BEGIN (which SQLite rejects).
   */
  private runInTransaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback may fail if the transaction was already aborted; ignore.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
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
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM transcript_chunks WHERE collection_id = ? AND video_id = ?").run(collectionId, videoId);
      this.db.prepare("DELETE FROM collection_videos WHERE collection_id = ? AND video_id = ?").run(collectionId, videoId);
    });
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
    this.runInTransaction(() => {
      // ON DELETE CASCADE clears collection_videos, transcript_chunks and
      // collection_models; do it and the active-state clear atomically.
      this.db.prepare("DELETE FROM collections WHERE collection_id = ?").run(collectionId);
      if (wasActive) {
        this.deleteAppState("active_collection_id");
      }
    });

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

    const targetAlgorithm = selectionToAlgorithm(selection);
    // When the collection is already on this exact Gemini model, only chunks
    // that lack an embedding (freshly imported) need to be embedded — never
    // re-embed the whole collection (that was the paid-cost bug). When the
    // stored algorithm differs (e.g. converting a local collection to Gemini),
    // every chunk must be re-embedded.
    const alreadyOnTarget = model.algorithm === targetAlgorithm;
    const rowsToEmbed = alreadyOnTarget
      ? rows.filter((row) => safeParseNumberArray(row.embeddingJson).length === 0)
      : rows;

    if (rowsToEmbed.length === 0) {
      return;
    }

    const provider = await createEmbeddingProvider(selection);
    if (!provider) {
      return;
    }
    const embeddings = await provider.embedDocuments(rowsToEmbed.map((row) => row.text));
    if (embeddings.length !== rowsToEmbed.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} vectors for ${rowsToEmbed.length} chunks.`);
    }

    const updateChunk = this.db.prepare(`
      UPDATE transcript_chunks
      SET doc_norm = ?, embedding_json = ?
      WHERE chunk_id = ?
    `);

    this.runInTransaction(() => {
      rowsToEmbed.forEach((row, index) => {
        const embedding = embeddings[index] ?? [];
        updateChunk.run(magnitudeOf(embedding) || 1, JSON.stringify(embedding), row.chunkId);
      });
      this.db.prepare(`
        UPDATE collection_models
        SET algorithm = ?, sigma_json = ?, chunk_count = ?, built_at = ?
        WHERE collection_id = ?
      `).run(
        targetAlgorithm,
        JSON.stringify([]),
        rows.length,
        new Date().toISOString(),
        collectionId,
      );
    });
  }

  /**
   * The embedding algorithm a collection is currently stored under, or null if
   * the collection has no model yet. Lets callers decide whether a Gemini
   * reindex is required (a Gemini collection must never be silently downgraded
   * to local — see persistItems).
   */
  collectionEmbeddingSelection(collectionId: string): EmbeddingSelection | null {
    const model = this.loadModel(collectionId);
    return model ? parseAlgorithmSelection(model.algorithm) : null;
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
	          sourcePlatform: row.sourcePlatform as SearchTranscriptsOutput["results"][number]["sourcePlatform"],
	          sourceId: row.sourceId,
	          canonicalUrl: row.canonicalUrl,
	          chunkText: row.text,
	          tStartSec: row.tStartSec,
	          tEndSec: row.tEndSec,
	          timestampUrl: buildTimestampUrl(row.videoId, row.tStartSec, row.sourcePlatform, row.canonicalUrl),
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
	        source_platform, source_id, canonical_url, transcript_characters, transcript_segments, imported_at
	      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	    `);
    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO transcript_chunks (
        chunk_id, collection_id, video_id, ordinal, t_start_sec, t_end_sec, text, token_count, terms_json, doc_norm, embedding_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Capture the algorithm the collection is stored under BEFORE this import so
    // we never silently downgrade a Gemini collection to local (WS2-1). This is
    // read before any writes; deleteVideo below leaves collection_models intact.
    const priorAlgorithm = this.loadModel(collectionId)?.algorithm;
    const priorSelection = priorAlgorithm ? parseAlgorithmSelection(priorAlgorithm) : null;

    this.runInTransaction(() => {
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
	            item.video.sourcePlatform ?? "youtube",
	            item.video.sourceId ?? item.video.videoId,
	            item.video.canonicalUrl ?? item.video.url ?? buildVideoUrl(item.video.videoId),
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
    });
    if (imported > 0) {
      if (priorSelection?.kind === "gemini") {
        // Gemini collection: preserve the existing paid embeddings and keep the
        // stored algorithm. Only refresh the lexical (idf) model over all chunks;
        // freshly imported chunks stay unembedded until a Gemini reindex runs
        // (the caller triggers it via reindexCollectionEmbeddings, which now
        // embeds only the new chunks). We never overwrite existing embeddings
        // with local LSA vectors.
        this.rebuildLexicalModel(collectionId, priorAlgorithm!);
      } else {
        this.rebuildCollectionModel(collectionId);
      }
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

    // Chunk embeddings and the model metadata (idf/sigma) must land together, or
    // a crash between them leaves the stored idf inconsistent with the vectors
    // and silently wrong search rankings (WS2-3).
    this.runInTransaction(() => {
      normalizedDocs.forEach((item, index) => {
        const embedding = decomposition.embeddings[index] ?? [];
        updateChunk.run(item.norm, JSON.stringify(embedding), item.row.chunkId);
      });
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
    });
  }

  /**
   * Refresh only the lexical (TF-IDF) model for a collection while preserving
   * the stored algorithm and every chunk's existing embedding. Used for
   * incremental imports into a Gemini collection: the local LSA rebuild would
   * overwrite the paid Gemini vectors, so we recompute idf over all chunks (so
   * lexical scoring stays fresh) but leave embeddings untouched. Newly imported
   * chunks keep their null embedding until the caller runs a Gemini reindex.
   */
  private rebuildLexicalModel(collectionId: string, algorithm: string): void {
    const rows = this.loadSearchRows(collectionId);
    if (rows.length === 0) {
      this.db.prepare("DELETE FROM collection_models WHERE collection_id = ?").run(collectionId);
      return;
    }

    const idf = buildIdfMap(rows.map((row) => safeParseCounts(row.termsJson)));

    this.runInTransaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO collection_models (collection_id, algorithm, chunk_count, sigma_json, idf_json, built_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        collectionId,
        algorithm,
        rows.length,
        JSON.stringify([]),
        JSON.stringify(idf),
        new Date().toISOString(),
      );
    });
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
    const params: string[] = [collectionId];
    let query = `
      SELECT
        ch.chunk_id,
        ch.collection_id,
	        ch.video_id,
	        v.title AS video_title,
	        v.channel_title,
	        v.source_platform,
	        v.source_id,
	        v.canonical_url,
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
    `;

    if (videoFilter && videoFilter.size > 0) {
      const filteredVideoIds = Array.from(videoFilter);
      const placeholders = filteredVideoIds.map(() => "?").join(", ");
      query += ` AND ch.video_id IN (${placeholders})`;
      params.push(...filteredVideoIds);
    }

    query += " ORDER BY ch.video_id ASC, ch.ordinal ASC";

    const rows = this.db.prepare(query).all(...params) as Array<{
      chunk_id: string;
      collection_id: string;
      video_id: string;
      video_title: string | null;
	      channel_title: string | null;
	      source_platform: string | null;
	      source_id: string | null;
	      canonical_url: string | null;
	      ordinal: number;
      t_start_sec: number;
      t_end_sec: number | null;
      text: string;
      terms_json: string;
      doc_norm: number | null;
      embedding_json: string | null;
    }>;

    return rows.map((row) => ({
        chunkId: row.chunk_id,
        collectionId: row.collection_id,
        videoId: row.video_id,
	        videoTitle: row.video_title ?? row.video_id,
	        channelTitle: row.channel_title ?? "Unknown channel",
	        sourcePlatform: row.source_platform ?? undefined,
	        sourceId: row.source_id ?? undefined,
	        canonicalUrl: row.canonical_url ?? undefined,
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
	    sourcePlatform: row.sourcePlatform,
	    sourceId: row.sourceId,
	    canonicalUrl: row.canonicalUrl,
	    ordinal: row.ordinal,
    tStartSec: row.tStartSec,
    tEndSec: row.tEndSec,
    text: row.text,
    terms: safeParseCounts(row.termsJson),
    docNorm: Number(row.docNorm ?? 1),
    embedding: safeParseNumberArray(row.embeddingJson),
  }));

  const lexicalScores = chunks.map((chunk) => lexicalSimilarity(chunk.terms, queryVector, queryNorm, model.idf));
  const selection = parseAlgorithmSelection(model.algorithm);

  let semanticScores: Array<number | undefined> = [];
  let semanticFallback = false;

  if (selection.kind === "gemini" && chunks.some((chunk) => chunk.embedding.length > 0)) {
    try {
      const provider = await createEmbeddingProvider(selection);
      if (provider) {
        const queryEmbedding = await provider.embedQuery(query);
        semanticScores = cosineSimilarities(chunks.map((chunk) => chunk.embedding), queryEmbedding);
      }
    } catch {
      semanticFallback = true;
    }
  } else {
    const hasEmbedding = model.sigma.length > 0 && chunks.some((chunk) => chunk.embedding.length > 0);
    semanticScores = hasEmbedding ? semanticSimilarities(chunks.map((chunk) => chunk.embedding), lexicalScores, model.sigma) : [];
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

function buildTimestampUrl(videoId: string, tStartSec: number, sourcePlatform?: string, canonicalUrl?: string): string {
  const seconds = Math.max(0, Math.floor(tStartSec));
  if (!sourcePlatform || sourcePlatform === "youtube") {
    return `https://youtu.be/${videoId}?t=${seconds}`;
  }
  if (!canonicalUrl) {
    return videoId;
  }
  if (sourcePlatform === "generic_url" || sourcePlatform === "local_file") {
    return canonicalUrl;
  }
  try {
    const url = new URL(canonicalUrl);
    if (sourcePlatform === "x") {
      url.searchParams.set("t", `${seconds}s`);
      return url.toString();
    }
    return canonicalUrl;
  } catch {
    return canonicalUrl;
  }
}

function humanizeAlgorithm(algorithm: string): string {
  const selection = parseAlgorithmSelection(algorithm);
  if (selection.kind === "gemini") {
    return `Gemini embeddings (${selection.model}, ${selection.dimensions}d)`;
  }
  return DEFAULT_LOCAL_EMBEDDING_MODEL;
}

function localProvenance(): Provenance {
  return buildLocalProvenance("Query served from the local transcript knowledge base.");
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

export function resolveCollectionIdForPlaylist(input: PlaylistKnowledgeBaseInput): string {
  return input.collectionId ?? TranscriptKnowledgeBase.playlistCollectionId(input.playlistUrlOrId);
}
