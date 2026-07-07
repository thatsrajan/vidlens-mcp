/**
 * Comment Knowledge Base — indexes YouTube comments for search.
 *
 * Parallel to TranscriptKnowledgeBase but for comment content.
 * Uses the same TF-IDF + LSA embedding approach for local search.
 * Stores in the same SQLite database with separate tables.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { buildVideoUrl } from "./id-parsing.js";
import { KNOWLEDGE_BASE_MIGRATIONS, runMigrations } from "./schema-migration.js";
import {
  buildIdfMap,
  buildLocalProvenance,
  buildNormalizedVector,
  buildSimilarityMatrix,
  buildTermCounts,
  decomposeSimilarity,
  lexicalSimilarity,
  round,
  safeParseCounts,
  safeParseNumberArray,
  safeParseNumberMap,
  semanticSimilarities,
  slugify,
  vectorNorm,
} from "./text-math.js";
import type {
  CollectionScopeMeta,
  CommentCollectionSummary,
  CommentRecord,
  ImportCommentsOutput,
  ListCommentCollectionsOutput,
  Provenance,
  RemoveCommentCollectionOutput,
  SearchCommentsInput,
  SearchCommentsOutput,
  SetActiveCommentCollectionOutput,
  ClearActiveCommentCollectionOutput,
} from "./types.js";

const DEFAULT_LOCAL_EMBEDDING_MODEL =
  "local-lsa-hybrid-v1 (TF-IDF + latent semantic projection, no external model)";

interface KnowledgeBaseConfig {
  dataDir?: string;
}

export interface CommentCollectionSeed {
  collectionId: string;
  label?: string;
}

export interface CommentImportItem {
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  comments: CommentRecord[];
}

interface StoredCommentChunk {
  chunkId: string;
  collectionId: string;
  videoId: string;
  videoTitle: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt?: string;
  isReply: boolean;
  parentAuthor?: string;
  terms: Record<string, number>;
  docNorm: number;
  embedding: number[];
}

interface CommentSearchRow {
  chunkId: string;
  collectionId: string;
  videoId: string;
  videoTitle: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string | null;
  isReply: number;
  parentAuthor: string | null;
  termsJson: string;
  docNorm: number | null;
  embeddingJson: string | null;
}

interface CollectionModel {
  algorithm: string;
  builtAt: string;
  chunkCount: number;
  sigma: number[];
  idf: Record<string, number>;
}

function defaultDataDir(): string {
  return (
    process.env.VIDLENS_DATA_DIR ||
    join(homedir(), "Library", "Application Support", "vidlens-mcp")
  );
}

export class CommentKnowledgeBase {
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
      CREATE TABLE IF NOT EXISTS comment_collections (
        collection_id TEXT PRIMARY KEY,
        label TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comment_collection_videos (
        collection_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        title TEXT,
        channel_title TEXT,
        thread_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, video_id),
        FOREIGN KEY (collection_id) REFERENCES comment_collections(collection_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS comment_chunks (
        chunk_id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        like_count INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        is_reply INTEGER NOT NULL DEFAULT 0,
        parent_author TEXT,
        token_count INTEGER NOT NULL,
        terms_json TEXT NOT NULL,
        doc_norm REAL,
        embedding_json TEXT,
        FOREIGN KEY (collection_id) REFERENCES comment_collections(collection_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS comment_collection_models (
        collection_id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        sigma_json TEXT NOT NULL,
        idf_json TEXT NOT NULL,
        built_at TEXT NOT NULL,
        FOREIGN KEY (collection_id) REFERENCES comment_collections(collection_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS comment_app_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    // knowledge-base.sqlite is shared with TranscriptKnowledgeBase; run the same
    // guarded migrations after our base schema exists so PRAGMA user_version is
    // maintained regardless of which store opens the file first.
    runMigrations(this.db, "knowledge-base.sqlite", KNOWLEDGE_BASE_MIGRATIONS);
  }

  private inTransaction = false;

  /**
   * Run `fn` inside a single SQLite transaction. Reentrant so nested calls
   * (deleteVideo within importComments) don't issue a nested BEGIN.
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

  // ── Collection CRUD ──

  ensureCollection(seed: CommentCollectionSeed): {
    collectionId: string;
    created: boolean;
  } {
    const existing = this.db
      .prepare(
        "SELECT collection_id FROM comment_collections WHERE collection_id = ?",
      )
      .get(seed.collectionId) as { collection_id: string } | undefined;
    const now = new Date().toISOString();

    if (existing) {
      this.db
        .prepare(
          `UPDATE comment_collections
           SET label = COALESCE(?, label), updated_at = ?
           WHERE collection_id = ?`,
        )
        .run(seed.label ?? null, now, seed.collectionId);
      return { collectionId: seed.collectionId, created: false };
    }

    this.db
      .prepare(
        `INSERT INTO comment_collections (collection_id, label, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(seed.collectionId, seed.label ?? null, now, now);
    return { collectionId: seed.collectionId, created: true };
  }

  hasVideo(collectionId: string, videoId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM comment_collection_videos WHERE collection_id = ? AND video_id = ?",
      )
      .get(collectionId, videoId) as { 1: number } | undefined;
    return Boolean(row);
  }

  deleteVideo(collectionId: string, videoId: string): void {
    this.runInTransaction(() => {
      this.db
        .prepare(
          "DELETE FROM comment_chunks WHERE collection_id = ? AND video_id = ?",
        )
        .run(collectionId, videoId);
      this.db
        .prepare(
          "DELETE FROM comment_collection_videos WHERE collection_id = ? AND video_id = ?",
        )
        .run(collectionId, videoId);
    });
  }

  // ── Import ──

  importComments(
    seed: CommentCollectionSeed,
    items: CommentImportItem[],
  ): ImportCommentsOutput {
    this.ensureCollection(seed);
    const collectionId = seed.collectionId;

    let totalThreads = 0;
    let totalComments = 0;
    let chunksCreated = 0;

    const insertVideo = this.db.prepare(`
      INSERT OR REPLACE INTO comment_collection_videos
        (collection_id, video_id, title, channel_title, thread_count, comment_count, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO comment_chunks
        (chunk_id, collection_id, video_id, author, text, like_count, published_at,
         is_reply, parent_author, token_count, terms_json, doc_norm, embedding_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.runInTransaction(() => {
      for (const item of items) {
        this.deleteVideo(collectionId, item.videoId);
        let videoThreads = 0;
        let videoComments = 0;

        for (const thread of item.comments) {
          videoThreads += 1;
          // Index top-level comment
          const topText = thread.text.replace(/\s+/g, " ").trim();
          if (topText.length >= 5) {
            const terms = buildTermCounts(topText);
            const tokenCount = Object.values(terms).reduce(
              (s, c) => s + c,
              0,
            );
            if (tokenCount >= 2) {
              insertChunk.run(
                randomUUID(),
                collectionId,
                item.videoId,
                thread.author,
                topText,
                thread.likeCount ?? 0,
                thread.publishedAt ?? null,
                0,
                null,
                tokenCount,
                JSON.stringify(terms),
                null,
                null,
              );
              chunksCreated += 1;
              videoComments += 1;
            }
          }

          // Index replies
          for (const reply of thread.replies ?? []) {
            const replyText = reply.text.replace(/\s+/g, " ").trim();
            if (replyText.length >= 5) {
              const terms = buildTermCounts(replyText);
              const tokenCount = Object.values(terms).reduce(
                (s, c) => s + c,
                0,
              );
              if (tokenCount >= 2) {
                insertChunk.run(
                  randomUUID(),
                  collectionId,
                  item.videoId,
                  reply.author,
                  replyText,
                  reply.likeCount ?? 0,
                  reply.publishedAt ?? null,
                  1,
                  thread.author,
                  tokenCount,
                  JSON.stringify(terms),
                  null,
                  null,
                );
                chunksCreated += 1;
                videoComments += 1;
              }
            }
          }
        }

        totalThreads += videoThreads;
        totalComments += videoComments;
        const now = new Date().toISOString();
        insertVideo.run(
          collectionId,
          item.videoId,
          item.videoTitle,
          item.channelTitle,
          videoThreads,
          videoComments,
          now,
        );
      }
    });

    if (chunksCreated > 0) {
      this.rebuildCollectionModel(collectionId);
      this.touchCollection(collectionId);
    }

    return {
      videoId: items.length === 1 ? items[0].videoId : items.map((i) => i.videoId).join(","),
      collectionId,
      import: {
        totalThreads,
        totalComments,
        chunksCreated,
      },
      provenance: localProvenance(),
    };
  }

  // ── Search ──

  async search(input: SearchCommentsInput): Promise<SearchCommentsOutput> {
    const startedAt = Date.now();
    const maxResults = Math.max(1, Math.min(input.maxResults ?? 10, 50));
    const minScore = Math.max(0, Math.min(input.minScore ?? 0.15, 1));
    const scope = this.resolveCollectionScope(input);
    const targetCollections = scope.searchedCollectionIds;
    const videoFilter = input.videoIdFilter
      ? new Set(input.videoIdFilter)
      : undefined;
    const results: SearchCommentsOutput["results"] = [];
    let totalChunksSearched = 0;
    const embeddingModelLabel = DEFAULT_LOCAL_EMBEDDING_MODEL;

    for (const collectionId of targetCollections) {
      const model = this.loadModel(collectionId);
      if (!model || model.chunkCount === 0) continue;
      const rows = this.loadSearchRows(collectionId, videoFilter);
      if (rows.length === 0) continue;
      totalChunksSearched += rows.length;

      const ranked = rankComments(rows, model, input.query);

      for (const row of ranked) {
        if (row.score < minScore) continue;
        results.push({
          collectionId,
          videoId: row.videoId,
          videoTitle: row.videoTitle,
          author: row.author,
          commentText: row.text,
          likeCount: row.likeCount,
          publishedAt: row.publishedAt,
          isReply: row.isReply,
          parentAuthor: row.parentAuthor,
          score: round(row.score, 4),
          lexicalScore: round(row.lexicalScore, 4),
          semanticScore:
            row.semanticScore !== undefined
              ? round(row.semanticScore, 4)
              : undefined,
        });
      }
    }

    const deduped = results
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.likeCount ?? 0) - (a.likeCount ?? 0),
      )
      .slice(0, maxResults);

    return {
      query: input.query,
      results: deduped,
      searchMeta: {
        totalChunksSearched,
        embeddingModel: embeddingModelLabel,
        searchLatencyMs: Date.now() - startedAt,
        scope,
      },
      provenance: localProvenance(),
    };
  }

  // ── List ──

  listCollections(
    includeVideoList = false,
  ): ListCommentCollectionsOutput {
    const rows = this.db
      .prepare(
        `SELECT
           c.collection_id,
           c.label,
           c.created_at,
           c.updated_at,
           COALESCE((SELECT COUNT(*) FROM comment_collection_videos v WHERE v.collection_id = c.collection_id), 0) AS video_count,
           COALESCE((SELECT COUNT(*) FROM comment_chunks ch WHERE ch.collection_id = c.collection_id), 0) AS total_chunks
         FROM comment_collections c
         ORDER BY c.updated_at DESC, c.collection_id ASC`,
      )
      .all() as Array<{
      collection_id: string;
      label: string | null;
      created_at: string;
      updated_at: string;
      video_count: number;
      total_chunks: number;
    }>;

    const activeCollectionId = this.getActiveCollectionId();
    const videoMap = includeVideoList
      ? this.loadVideosForCollections(rows.map((r) => r.collection_id))
      : new Map<string, CommentCollectionSummary["videos"]>();

    return {
      collections: rows.map((row) => ({
        collectionId: row.collection_id,
        label: row.label ?? undefined,
        videoCount: Number(row.video_count ?? 0),
        totalCommentChunks: Number(row.total_chunks ?? 0),
        createdAt: row.created_at,
        lastUpdatedAt: row.updated_at,
        isActive: row.collection_id === activeCollectionId,
        videos: videoMap.get(row.collection_id),
      })),
      activeCollectionId: activeCollectionId ?? undefined,
      provenance: localProvenance(),
    };
  }

  // ── Active Collection ──

  setActiveCollection(
    collectionId: string,
  ): SetActiveCommentCollectionOutput {
    const exists = this.db
      .prepare(
        "SELECT 1 FROM comment_collections WHERE collection_id = ?",
      )
      .get(collectionId);
    if (!exists) throw new Error(`Comment collection not found: ${collectionId}`);

    this.setAppState("active_comment_collection_id", collectionId);
    const summary = this.getCollectionSummary(collectionId);
    return {
      activeCollectionId: collectionId,
      collection: summary ?? undefined,
      provenance: localProvenance(),
    };
  }

  clearActiveCollection(): ClearActiveCommentCollectionOutput {
    const previousActiveCollectionId = this.getActiveCollectionId();
    this.deleteAppState("active_comment_collection_id");
    return {
      cleared: Boolean(previousActiveCollectionId),
      previousActiveCollectionId: previousActiveCollectionId ?? undefined,
      provenance: localProvenance(),
    };
  }

  getActiveCollectionId(): string | null {
    const row = this.db
      .prepare("SELECT value FROM comment_app_state WHERE key = ?")
      .get("active_comment_collection_id") as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  // ── Remove ──

  removeCollection(collectionId: string): RemoveCommentCollectionOutput {
    const existing = this.db
      .prepare(
        "SELECT 1 FROM comment_collections WHERE collection_id = ?",
      )
      .get(collectionId);
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

    const chunkRow = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM comment_chunks WHERE collection_id = ?",
      )
      .get(collectionId) as { count: number } | undefined;
    const videoRow = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM comment_collection_videos WHERE collection_id = ?",
      )
      .get(collectionId) as { count: number } | undefined;

    const wasActive = this.getActiveCollectionId() === collectionId;
    this.runInTransaction(() => {
      // ON DELETE CASCADE clears the child tables; do it and the active-state
      // clear atomically.
      this.db
        .prepare("DELETE FROM comment_collections WHERE collection_id = ?")
        .run(collectionId);
      if (wasActive) {
        this.deleteAppState("active_comment_collection_id");
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

  // ── Static Helpers ──

  static videoCommentCollectionId(videoId: string): string {
    return `comments-${videoId}`;
  }

  static videosCommentCollectionId(videoIds: string[], label?: string): string {
    const labelPart = slugify(label ?? "comments");
    const fingerprint = createHash("sha1")
      .update(videoIds.join("\n"))
      .digest("hex")
      .slice(0, 8);
    return `comments-${labelPart}-${fingerprint}`;
  }

  close(): void {
    this.db.close();
  }

  // ── Private ──

  private rebuildCollectionModel(collectionId: string): void {
    const rows = this.loadSearchRows(collectionId);
    if (rows.length === 0) {
      this.db
        .prepare(
          "DELETE FROM comment_collection_models WHERE collection_id = ?",
        )
        .run(collectionId);
      return;
    }

    const documents = rows.map((row) => ({
      row,
      terms: safeParseCounts(row.termsJson),
    }));
    const idf = buildIdfMap(documents.map((d) => d.terms));
    const normalizedDocs = documents.map((d) => {
      const normalized = buildNormalizedVector(d.terms, idf);
      return { ...d, normalized, norm: vectorNorm(normalized) };
    });

    const similarity = buildSimilarityMatrix(
      normalizedDocs.map((d) => d.normalized),
    );
    const decomposition = decomposeSimilarity(
      similarity,
      Math.min(12, normalizedDocs.length),
    );

    const updateChunk = this.db.prepare(`
      UPDATE comment_chunks
      SET doc_norm = ?, embedding_json = ?
      WHERE chunk_id = ?
    `);

    // Chunk embeddings and the model metadata (idf/sigma) must commit together,
    // or a crash between them leaves the stored idf inconsistent with the
    // vectors and silently wrong rankings (WS2-3).
    this.runInTransaction(() => {
      normalizedDocs.forEach((item, index) => {
        const embedding = decomposition.embeddings[index] ?? [];
        updateChunk.run(item.norm, JSON.stringify(embedding), item.row.chunkId);
      });
      this.db
        .prepare(
          `INSERT OR REPLACE INTO comment_collection_models
           (collection_id, algorithm, chunk_count, sigma_json, idf_json, built_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          collectionId,
          "local-lsa-hybrid-v1",
          normalizedDocs.length,
          JSON.stringify(decomposition.sigma),
          JSON.stringify(idf),
          new Date().toISOString(),
        );
    });
  }

  private resolveCollectionScope(
    input: SearchCommentsInput,
  ): CollectionScopeMeta {
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

  private listCollectionIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT collection_id FROM comment_collections ORDER BY updated_at DESC, collection_id ASC",
        )
        .all() as Array<{ collection_id: string }>
    ).map((row) => row.collection_id);
  }

  private getCollectionSummary(
    collectionId: string,
  ): CommentCollectionSummary | null {
    const all = this.listCollections(true);
    return (
      all.collections.find((c) => c.collectionId === collectionId) ?? null
    );
  }

  private loadSearchRows(
    collectionId: string,
    videoFilter?: Set<string>,
  ): CommentSearchRow[] {
    const params: string[] = [collectionId];
    let query = `SELECT
           ch.chunk_id,
           ch.collection_id,
           ch.video_id,
           v.title AS video_title,
           ch.author,
           ch.text,
           ch.like_count,
           ch.published_at,
           ch.is_reply,
           ch.parent_author,
           ch.terms_json,
           ch.doc_norm,
           ch.embedding_json
         FROM comment_chunks ch
         INNER JOIN comment_collection_videos v
           ON v.collection_id = ch.collection_id AND v.video_id = ch.video_id
         WHERE ch.collection_id = ?`;

    if (videoFilter && videoFilter.size > 0) {
      const filteredVideoIds = Array.from(videoFilter);
      const placeholders = filteredVideoIds.map(() => "?").join(", ");
      query += ` AND ch.video_id IN (${placeholders})`;
      params.push(...filteredVideoIds);
    }

    query += " ORDER BY ch.video_id ASC, ch.like_count DESC";

    const rows = this.db.prepare(query).all(...params) as Array<{
      chunk_id: string;
      collection_id: string;
      video_id: string;
      video_title: string | null;
      author: string;
      text: string;
      like_count: number;
      published_at: string | null;
      is_reply: number;
      parent_author: string | null;
      terms_json: string;
      doc_norm: number | null;
      embedding_json: string | null;
    }>;

    return rows
      .map((row) => ({
        chunkId: row.chunk_id,
        collectionId: row.collection_id,
        videoId: row.video_id,
        videoTitle: row.video_title ?? row.video_id,
        author: row.author,
        text: row.text,
        likeCount: Number(row.like_count ?? 0),
        publishedAt: row.published_at,
        isReply: Number(row.is_reply),
        parentAuthor: row.parent_author,
        termsJson: row.terms_json,
        docNorm: row.doc_norm,
        embeddingJson: row.embedding_json,
      }));
  }

  private loadModel(collectionId: string): CollectionModel | null {
    const row = this.db
      .prepare(
        `SELECT algorithm, chunk_count, sigma_json, idf_json, built_at
         FROM comment_collection_models
         WHERE collection_id = ?`,
      )
      .get(collectionId) as
      | {
          algorithm: string;
          chunk_count: number;
          sigma_json: string;
          idf_json: string;
          built_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      algorithm: row.algorithm,
      chunkCount: Number(row.chunk_count),
      sigma: safeParseNumberArray(row.sigma_json),
      idf: safeParseNumberMap(row.idf_json),
      builtAt: row.built_at,
    };
  }

  private loadVideosForCollections(
    collectionIds: string[],
  ): Map<string, CommentCollectionSummary["videos"]> {
    const map = new Map<string, CommentCollectionSummary["videos"]>();
    if (collectionIds.length === 0) return map;

    const placeholders = collectionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT collection_id, video_id, title, thread_count, comment_count
         FROM comment_collection_videos
         WHERE collection_id IN (${placeholders})
         ORDER BY collection_id ASC, imported_at DESC`,
      )
      .all(...collectionIds) as Array<{
      collection_id: string;
      video_id: string;
      title: string | null;
      thread_count: number;
      comment_count: number;
    }>;

    for (const row of rows) {
      const existing = map.get(row.collection_id) ?? [];
      existing.push({
        videoId: row.video_id,
        title: row.title ?? undefined,
        threadCount: Number(row.thread_count ?? 0),
        commentCount: Number(row.comment_count ?? 0),
      });
      map.set(row.collection_id, existing);
    }
    return map;
  }

  private setAppState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO comment_app_state (key, value, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(key, value, new Date().toISOString());
  }

  private deleteAppState(key: string): void {
    this.db
      .prepare("DELETE FROM comment_app_state WHERE key = ?")
      .run(key);
  }

  private touchCollection(collectionId: string): void {
    this.db
      .prepare(
        "UPDATE comment_collections SET updated_at = ? WHERE collection_id = ?",
      )
      .run(new Date().toISOString(), collectionId);
  }
}

// ── Ranking ──

function rankComments(
  rows: CommentSearchRow[],
  model: CollectionModel,
  query: string,
): Array<
  StoredCommentChunk & {
    score: number;
    lexicalScore: number;
    semanticScore?: number;
  }
> {
  const queryTerms = buildTermCounts(query);
  const queryVector = buildNormalizedVector(queryTerms, model.idf);
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm <= 0) return [];

  const chunks: StoredCommentChunk[] = rows.map((row) => ({
    chunkId: row.chunkId,
    collectionId: row.collectionId,
    videoId: row.videoId,
    videoTitle: row.videoTitle,
    author: row.author,
    text: row.text,
    likeCount: row.likeCount,
    publishedAt: row.publishedAt ?? undefined,
    isReply: Boolean(row.isReply),
    parentAuthor: row.parentAuthor ?? undefined,
    terms: safeParseCounts(row.termsJson),
    docNorm: Number(row.docNorm ?? 1),
    embedding: safeParseNumberArray(row.embeddingJson),
  }));

  const lexicalScores = chunks.map((chunk) =>
    lexicalSimilarity(chunk.terms, queryVector, queryNorm, model.idf),
  );

  const hasEmbedding =
    model.sigma.length > 0 && chunks.some((c) => c.embedding.length > 0);
  const semanticScores: Array<number | undefined> = hasEmbedding
    ? semanticSimilarities(chunks.map((chunk) => chunk.embedding), lexicalScores, model.sigma)
    : [];

  // Boost high-like comments slightly
  const maxLikes = Math.max(1, ...chunks.map((c) => c.likeCount));

  return chunks
    .map((chunk, index) => {
      const lex = lexicalScores[index] ?? 0;
      const sem = semanticScores[index];
      const baseScore =
        sem === undefined ? lex : lex * 0.35 + Math.max(sem, 0) * 0.65;
      // Like boost: up to 10% for the most liked comment
      const likeBoost = chunk.likeCount > 0 ? (chunk.likeCount / maxLikes) * 0.1 : 0;
      return {
        ...chunk,
        lexicalScore: lex,
        semanticScore: sem,
        score: baseScore + likeBoost,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.likeCount - a.likeCount,
    );
}

// ── NLP Utilities (shared with transcript KB) ──

// ── Math helpers ──

function localProvenance(): Provenance {
  return buildLocalProvenance("Query served from the local comment knowledge base.");
}
