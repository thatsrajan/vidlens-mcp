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

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for",
  "from", "had", "has", "have", "how", "if", "in", "into", "is", "it",
  "its", "just", "more", "most", "not", "of", "on", "or", "our", "that",
  "the", "their", "there", "these", "they", "this", "those", "to", "too",
  "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "you", "your",
]);

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

    this.db.exec("BEGIN");
    try {
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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

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
    this.db
      .prepare("DELETE FROM comment_collections WHERE collection_id = ?")
      .run(collectionId);
    if (wasActive) {
      this.deleteAppState("active_comment_collection_id");
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
    const rows = this.db
      .prepare(
        `SELECT
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
         WHERE ch.collection_id = ?
         ORDER BY ch.video_id ASC, ch.like_count DESC`,
      )
      .all(collectionId) as Array<{
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
      .filter((row) => !videoFilter || videoFilter.has(row.video_id))
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
    ? semanticSimilarities(chunks, lexicalScores, model.sigma)
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

function buildTermCounts(text: string): Record<string, number> {
  const words = tokenize(text);
  const counts: Record<string, number> = {};
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    counts[word] = (counts[word] ?? 0) + 1;
    const next = words[i + 1];
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
    .map((t) => stem(t.trim()))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function stem(token: string): string {
  let c = token;
  if (c.endsWith("ies") && c.length > 4) c = `${c.slice(0, -3)}y`;
  else if (c.endsWith("ing") && c.length > 5) c = c.slice(0, -3);
  else if (c.endsWith("ed") && c.length > 4) c = c.slice(0, -2);
  else if (c.endsWith("ly") && c.length > 4) c = c.slice(0, -2);
  else if (c.endsWith("es") && c.length > 4) c = c.slice(0, -2);
  else if (c.endsWith("s") && c.length > 3) c = c.slice(0, -1);
  return c;
}

function buildIdfMap(
  documents: Array<Record<string, number>>,
): Record<string, number> {
  const docCount = documents.length;
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const token of Object.keys(doc)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const rankedTokens = Array.from(df.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4000);
  return Object.fromEntries(
    rankedTokens.map(([token, freq]) => [
      token,
      1 + Math.log((docCount + 1) / (freq + 1)),
    ]),
  );
}

function buildNormalizedVector(
  terms: Record<string, number>,
  idf: Record<string, number>,
): Record<string, number> {
  const weighted: Record<string, number> = {};
  let normSquared = 0;
  for (const [token, count] of Object.entries(terms)) {
    const tokenIdf = idf[token];
    if (!tokenIdf) continue;
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

function buildSimilarityMatrix(
  vectors: Array<Record<string, number>>,
): Float64Array {
  const size = vectors.length;
  const matrix = new Float64Array(size * size);
  const inverted = new Map<
    string,
    Array<{ index: number; weight: number }>
  >();
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

function decomposeSimilarity(
  matrix: Float64Array,
  size: number,
): { sigma: number[]; embeddings: number[][] } {
  const sigma: number[] = [];
  const eigenvectors: number[][] = [];
  const maxComponents = Math.min(size, 12);
  for (let comp = 0; comp < maxComponents; comp += 1) {
    let vector = Array.from(
      { length: size },
      (_, i) => ((i + 1) * (comp + 3)) % 7 + 1,
    );
    vector = normalizeDense(vector);
    for (let iter = 0; iter < 20; iter += 1) {
      let multiplied = multiplyMatrixVector(matrix, size, vector);
      for (const prev of eigenvectors) {
        const proj = dot(prev, multiplied);
        multiplied = multiplied.map((v, i) => v - proj * prev[i]);
      }
      const mag = magnitudeOf(multiplied);
      if (mag < 1e-9) break;
      vector = multiplied.map((v) => v / mag);
    }
    const projected = multiplyMatrixVector(matrix, size, vector);
    const eigenvalue = dot(vector, projected);
    if (!Number.isFinite(eigenvalue) || eigenvalue <= 1e-8) break;
    sigma.push(Math.sqrt(eigenvalue));
    eigenvectors.push(vector);
  }
  const embeddings = Array.from({ length: size }, () =>
    Array.from({ length: sigma.length }, () => 0),
  );
  for (let i = 0; i < size; i += 1) {
    for (let c = 0; c < sigma.length; c += 1) {
      embeddings[i][c] = eigenvectors[c][i] * sigma[c];
    }
  }
  return { sigma, embeddings };
}

function lexicalSimilarity(
  docTerms: Record<string, number>,
  queryVector: Record<string, number>,
  queryNorm: number,
  idf: Record<string, number>,
): number {
  if (queryNorm <= 0) return 0;
  let dotProduct = 0;
  let docNormSquared = 0;
  for (const [token, count] of Object.entries(docTerms)) {
    const tokenIdf = idf[token];
    if (!tokenIdf) continue;
    const docWeight = (1 + Math.log(count)) * tokenIdf;
    docNormSquared += docWeight * docWeight;
    if (queryVector[token]) {
      dotProduct += docWeight * queryVector[token];
    }
  }
  const docNorm = Math.sqrt(docNormSquared) || 1;
  return dotProduct / (docNorm * Math.max(queryNorm, 1));
}

function semanticSimilarities(
  chunks: StoredCommentChunk[],
  lexicalScores: number[],
  sigma: number[],
): Array<number | undefined> {
  const queryEmb = Array.from({ length: sigma.length }, () => 0);
  for (let i = 0; i < chunks.length; i += 1) {
    const lex = lexicalScores[i] ?? 0;
    if (lex <= 0) continue;
    const emb = chunks[i].embedding;
    for (let c = 0; c < sigma.length; c += 1) {
      const divisor = sigma[c] ** 2 || 1;
      queryEmb[c] += lex * ((emb[c] ?? 0) / divisor);
    }
  }
  return cosineSimilarities(chunks, queryEmb);
}

function cosineSimilarities(
  chunks: StoredCommentChunk[],
  queryEmb: number[],
): Array<number | undefined> {
  const qMag = magnitudeOf(queryEmb);
  if (qMag <= 1e-9) return chunks.map(() => undefined);
  return chunks.map((chunk) => {
    const mag = magnitudeOf(chunk.embedding);
    if (mag <= 1e-9) return undefined;
    return dot(queryEmb, chunk.embedding) / (qMag * mag);
  });
}

// ── Math helpers ──

function vectorNorm(vector: Record<string, number>): number {
  return Math.sqrt(
    Object.values(vector).reduce((sum, v) => sum + v * v, 0),
  );
}

function multiplyMatrixVector(
  matrix: Float64Array,
  size: number,
  vector: number[],
): number[] {
  const result = new Array<number>(size).fill(0);
  for (let row = 0; row < size; row += 1) {
    let total = 0;
    const offset = row * size;
    for (let col = 0; col < size; col += 1) {
      total += matrix[offset + col] * vector[col];
    }
    result[row] = total;
  }
  return result;
}

function normalizeDense(values: number[]): number[] {
  const mag = magnitudeOf(values);
  if (mag <= 1e-9) return values;
  return values.map((v) => v / mag);
}

function magnitudeOf(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
}

function dot(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    total += (left[i] ?? 0) * (right[i] ?? 0);
  }
  return total;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "collection"
  );
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

function safeParseNumberArray(
  value: string | null | undefined,
): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as number[];
    return Array.isArray(parsed) ? parsed.map((n) => Number(n) || 0) : [];
  } catch {
    return [];
  }
}

function localProvenance(): Provenance {
  return {
    sourceTier: "none",
    fetchedAt: new Date().toISOString(),
    fallbackDepth: 3,
    partial: false,
    sourceNotes: [
      "Query served from the local comment knowledge base.",
    ],
  };
}
