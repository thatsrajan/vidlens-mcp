import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

export interface MigrationResult {
  dbPath: string;
  previousVersion: number;
  currentVersion: number;
  migrationsApplied: Migration[];
  errors: Array<{ version: number; error: string }>;
}

/**
 * Get the current schema version of a database.
 * Uses SQLite's built-in PRAGMA user_version (defaults to 0).
 */
export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

/**
 * Set the schema version of a database.
 */
export function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Run pending migrations on a SQLite database.
 *
 * Uses PRAGMA user_version to track the current schema version.
 * Migrations are applied in ascending version order. If a migration fails,
 * the process stops and returns the error — partial progress is preserved
 * (each migration runs in its own transaction).
 */
export function runMigrations(
  db: DatabaseSync,
  dbName: string,
  migrations: Migration[],
): MigrationResult {
  const previousVersion = getSchemaVersion(db);
  const result: MigrationResult = {
    dbPath: dbName,
    previousVersion,
    currentVersion: previousVersion,
    migrationsApplied: [],
    errors: [],
  };

  // Sort ascending and filter to only pending migrations
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > previousVersion);

  for (const migration of pending) {
    try {
      db.exec("BEGIN");
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      result.migrationsApplied.push(migration);
      result.currentVersion = migration.version;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback may fail if transaction was already aborted; ignore.
      }
      result.errors.push({
        version: migration.version,
        error: err instanceof Error ? err.message : String(err),
      });
      // Stop on first error
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Migration registries
// ---------------------------------------------------------------------------

/** Migrations for knowledge-base.sqlite (used by KB + Comment KB) */
export const KNOWLEDGE_BASE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — baseline existing tables",
    up: (_db) => {
      // Baseline marker only. Tables already exist via CREATE IF NOT EXISTS
      // in knowledge-base.ts and comment-knowledge-base.ts.
    },
  },
  {
    version: 2,
    description:
      "Add chunk_type column to transcript_chunks for comment/visual indexing",
    up: (db) => {
      // Guarded/idempotent so this runs safely from either store's constructor,
      // in any open order, on both fresh and legacy DBs:
      //   - If transcript_chunks doesn't exist yet (e.g. the comment store opened
      //     the shared file first), skip — the transcript store's CREATE TABLE
      //     already includes chunk_type when it later creates the table.
      //   - If the column already exists (fresh DB, or re-run), skip the ALTER —
      //     SQLite has no IF NOT EXISTS for ADD COLUMN.
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_chunks'")
        .get() as { 1: number } | undefined;
      if (!tableExists) {
        return;
      }
      const tableInfo = db.prepare("PRAGMA table_info(transcript_chunks)").all() as Array<{ name: string }>;
      const hasChunkType = tableInfo.some((col) => col.name === "chunk_type");
      if (!hasChunkType) {
        db.exec(
          "ALTER TABLE transcript_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'transcript'",
        );
      }
    },
  },
];

/** Migrations for media-manifest.db */
export const MEDIA_STORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — baseline existing tables",
    up: (_db) => {
      // Baseline marker only
    },
  },
];

/** Migrations for visual-index.db */
export const VISUAL_INDEX_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — baseline existing tables",
    up: (_db) => {
      // Baseline marker only
    },
  },
];
