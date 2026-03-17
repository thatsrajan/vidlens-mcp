import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheEntityType =
  | "search"
  | "trending"
  | "video_meta"
  | "channel_meta"
  | "transcript"
  | "comments"
  | "analysis"
  | "embedding"
  | "collection";

export interface CacheEntry {
  key: string;
  entityType: CacheEntityType;
  value: unknown;
  createdAt: string; // ISO-8601
  expiresAt: string | null; // null = persistent
}

export interface CacheStoreOptions {
  dataDir: string;
  maxEntries?: number; // default 10 000
  cleanupIntervalMs?: number; // default 300 000 (5 min)
}

// ---------------------------------------------------------------------------
// TTL configuration (milliseconds, null = persistent)
// ---------------------------------------------------------------------------

const TTL_MAP: Record<CacheEntityType, number | null> = {
  search: 15 * 60 * 1000, // 15 minutes
  trending: 15 * 60 * 1000, // 15 minutes
  video_meta: 6 * 60 * 60 * 1000, // 6 hours
  channel_meta: 6 * 60 * 60 * 1000, // 6 hours
  transcript: 24 * 60 * 60 * 1000, // 24 hours
  comments: 24 * 60 * 60 * 1000, // 24 hours
  analysis: 2 * 60 * 60 * 1000, // 2 hours
  embedding: null, // persistent
  collection: null, // persistent
};

// ---------------------------------------------------------------------------
// Key builder utility
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, collision-resistant cache key.
 *
 * Format: `{toolName}:{sha256-of-sorted-JSON-inputs}`
 */
export function buildCacheKey(
  toolName: string,
  inputs: Record<string, unknown>,
): string {
  const sorted = JSON.stringify(inputs, Object.keys(inputs).sort());
  const hash = createHash("sha256").update(sorted).digest("hex");
  return `${toolName}:${hash}`;
}

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

export class CacheStore {
  private db: DatabaseSync;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private maxEntries: number;

  constructor(private options: CacheStoreOptions) {
    mkdirSync(options.dataDir, { recursive: true });

    const dbPath = join(options.dataDir, "cache.db");
    this.db = new DatabaseSync(dbPath);
    this.maxEntries = options.maxEntries ?? 10_000;

    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cache_expires
        ON cache_entries(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cache_type
        ON cache_entries(entity_type);
    `);

    // Initial cleanup pass
    this.cleanup();

    // Periodic cleanup
    const intervalMs = options.cleanupIntervalMs ?? 300_000;
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
    // Allow the process to exit even if the timer is still alive
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Get a cached value. Returns null if expired or not found. */
  get<T = unknown>(key: string): T | null {
    const row = this.db
      .prepare(
        "SELECT value_json, expires_at FROM cache_entries WHERE key = ?",
      )
      .get(key) as { value_json: string; expires_at: string | null } | undefined;

    if (!row) return null;

    // Check expiration
    if (row.expires_at !== null && new Date(row.expires_at) <= new Date()) {
      // Lazily remove the expired entry
      this.db.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
      return null;
    }

    return JSON.parse(row.value_json) as T;
  }

  /** Set a cached value. TTL is determined by entityType. */
  set(key: string, entityType: CacheEntityType, value: unknown): void {
    const now = new Date();
    const createdAt = now.toISOString();
    const ttl = TTL_MAP[entityType];
    const expiresAt =
      ttl === null ? null : new Date(now.getTime() + ttl).toISOString();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO cache_entries (key, entity_type, value_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(key, entityType, JSON.stringify(value), createdAt, expiresAt);

    // Enforce max entries: keep the most recent ones
    this.enforceMaxEntries();
  }

  /** Invalidate a specific key. Returns true if a row was deleted. */
  invalidate(key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM cache_entries WHERE key = ?")
      .run(key);
    return Number(result.changes) > 0;
  }

  /** Invalidate all entries matching an entity type. Returns count removed. */
  invalidateByType(entityType: CacheEntityType): number {
    const result = this.db
      .prepare("DELETE FROM cache_entries WHERE entity_type = ?")
      .run(entityType);
    return Number(result.changes);
  }

  /** Remove all expired entries. Returns count removed. */
  cleanup(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);
    return Number(result.changes);
  }

  /** Get cache stats: total entries, expired, by type. */
  stats(): {
    total: number;
    expired: number;
    byType: Record<string, number>;
  } {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM cache_entries")
      .get() as { cnt: number };

    const now = new Date().toISOString();
    const expiredRow = this.db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .get(now) as { cnt: number };

    const typeRows = this.db
      .prepare(
        "SELECT entity_type, COUNT(*) AS cnt FROM cache_entries GROUP BY entity_type",
      )
      .all() as Array<{ entity_type: string; cnt: number }>;

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.entity_type] = row.cnt;
    }

    return {
      total: totalRow.cnt,
      expired: expiredRow.cnt,
      byType,
    };
  }

  /** Close the database and stop cleanup timer. */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.db.close();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * If total entry count exceeds maxEntries, delete the oldest non-persistent
   * entries first, then oldest persistent entries as a last resort.
   */
  private enforceMaxEntries(): void {
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM cache_entries")
      .get() as { cnt: number };

    if (countRow.cnt <= this.maxEntries) return;

    const excess = countRow.cnt - this.maxEntries;
    // Remove oldest expirable entries first (those with an expires_at)
    this.db
      .prepare(
        `DELETE FROM cache_entries WHERE key IN (
           SELECT key FROM cache_entries
           ORDER BY
             CASE WHEN expires_at IS NOT NULL THEN 0 ELSE 1 END,
             created_at ASC
           LIMIT ?
         )`,
      )
      .run(excess);
  }
}
