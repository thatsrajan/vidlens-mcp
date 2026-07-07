import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  getSchemaVersion,
  setSchemaVersion,
  runMigrations,
  KNOWLEDGE_BASE_MIGRATIONS,
  type Migration,
} from "../lib/schema-migration.js";

// Helper: create a temporary database that is cleaned up after the test
function tmpDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-schema-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  return { db, dir };
}

// ---------------------------------------------------------------------------
// 1. getSchemaVersion returns 0 for fresh database
// ---------------------------------------------------------------------------
test("getSchemaVersion returns 0 for a fresh database", () => {
  const { db, dir } = tmpDb();
  try {
    assert.equal(getSchemaVersion(db), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. setSchemaVersion sets and persists version
// ---------------------------------------------------------------------------
test("setSchemaVersion sets and persists the version", () => {
  const { db, dir } = tmpDb();
  try {
    setSchemaVersion(db, 42);
    assert.equal(getSchemaVersion(db), 42);

    // Reopen to verify persistence
    db.close();
    const db2 = new DatabaseSync(join(dir, "test.db"));
    assert.equal(getSchemaVersion(db2), 42);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. runMigrations applies all migrations on fresh DB
// ---------------------------------------------------------------------------
test("runMigrations applies all migrations on a fresh database", () => {
  const { db, dir } = tmpDb();
  try {
    const migrations: Migration[] = [
      { version: 1, description: "first", up: (d) => d.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY)") },
      { version: 2, description: "second", up: (d) => d.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY)") },
    ];

    const result = runMigrations(db, "test.db", migrations);

    assert.equal(result.previousVersion, 0);
    assert.equal(result.currentVersion, 2);
    assert.equal(result.migrationsApplied.length, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(getSchemaVersion(db), 2);

    // Verify tables actually exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("t1"));
    assert.ok(names.includes("t2"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. runMigrations skips already-applied migrations
// ---------------------------------------------------------------------------
test("runMigrations skips already-applied migrations", () => {
  const { db, dir } = tmpDb();
  try {
    setSchemaVersion(db, 3);
    const migrations: Migration[] = [
      { version: 1, description: "old", up: () => { throw new Error("should not run"); } },
      { version: 2, description: "old", up: () => { throw new Error("should not run"); } },
      { version: 3, description: "old", up: () => { throw new Error("should not run"); } },
    ];

    const result = runMigrations(db, "test.db", migrations);

    assert.equal(result.migrationsApplied.length, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(result.currentVersion, 3);
    assert.equal(result.previousVersion, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. runMigrations applies only new migrations when partially applied
// ---------------------------------------------------------------------------
test("runMigrations applies only new migrations when version is partially applied", () => {
  const { db, dir } = tmpDb();
  try {
    setSchemaVersion(db, 1);
    let ran: number[] = [];
    const migrations: Migration[] = [
      { version: 1, description: "already done", up: () => { ran.push(1); } },
      { version: 2, description: "new", up: () => { ran.push(2); } },
      { version: 3, description: "new", up: () => { ran.push(3); } },
    ];

    const result = runMigrations(db, "test.db", migrations);

    assert.deepEqual(ran, [2, 3]);
    assert.equal(result.previousVersion, 1);
    assert.equal(result.currentVersion, 3);
    assert.equal(result.migrationsApplied.length, 2);
    assert.equal(result.migrationsApplied[0].version, 2);
    assert.equal(result.migrationsApplied[1].version, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. runMigrations stops on error and reports it
// ---------------------------------------------------------------------------
test("runMigrations stops on error and reports it", () => {
  const { db, dir } = tmpDb();
  try {
    const migrations: Migration[] = [
      { version: 1, description: "ok", up: (d) => d.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY)") },
      { version: 2, description: "fails", up: () => { throw new Error("intentional failure"); } },
      { version: 3, description: "never reached", up: () => { throw new Error("should not run"); } },
    ];

    const result = runMigrations(db, "test.db", migrations);

    assert.equal(result.migrationsApplied.length, 1);
    assert.equal(result.migrationsApplied[0].version, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].version, 2);
    assert.ok(result.errors[0].error.includes("intentional failure"));
    assert.equal(result.currentVersion, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. runMigrations returns correct previousVersion and currentVersion
// ---------------------------------------------------------------------------
test("runMigrations returns correct previousVersion and currentVersion", () => {
  const { db, dir } = tmpDb();
  try {
    setSchemaVersion(db, 5);
    const migrations: Migration[] = [
      { version: 6, description: "six", up: () => {} },
      { version: 7, description: "seven", up: () => {} },
    ];

    const result = runMigrations(db, "my-db", migrations);

    assert.equal(result.dbPath, "my-db");
    assert.equal(result.previousVersion, 5);
    assert.equal(result.currentVersion, 7);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. runMigrations handles empty migration list
// ---------------------------------------------------------------------------
test("runMigrations handles empty migration list", () => {
  const { db, dir } = tmpDb();
  try {
    const result = runMigrations(db, "test.db", []);

    assert.equal(result.previousVersion, 0);
    assert.equal(result.currentVersion, 0);
    assert.equal(result.migrationsApplied.length, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. runMigrations sorts migrations by version regardless of input order
// ---------------------------------------------------------------------------
test("runMigrations sorts migrations by version regardless of input order", () => {
  const { db, dir } = tmpDb();
  try {
    const order: number[] = [];
    const migrations: Migration[] = [
      { version: 3, description: "three", up: () => { order.push(3); } },
      { version: 1, description: "one", up: () => { order.push(1); } },
      { version: 2, description: "two", up: () => { order.push(2); } },
    ];

    const result = runMigrations(db, "test.db", migrations);

    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(result.currentVersion, 3);
    assert.equal(result.migrationsApplied.length, 3);
    assert.equal(result.migrationsApplied[0].version, 1);
    assert.equal(result.migrationsApplied[1].version, 2);
    assert.equal(result.migrationsApplied[2].version, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Failed migration doesn't corrupt previous state (rollback works)
// ---------------------------------------------------------------------------
test("failed migration rolls back — previous state preserved", () => {
  const { db, dir } = tmpDb();
  try {
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO things (name) VALUES (?)").run("original");

    const migrations: Migration[] = [
      {
        version: 1,
        description: "baseline",
        up: () => {},
      },
      {
        version: 2,
        description: "fails midway",
        up: (d) => {
          d.exec("ALTER TABLE things ADD COLUMN extra TEXT");
          // Now trigger an error — duplicate column
          d.exec("ALTER TABLE things ADD COLUMN extra TEXT");
        },
      },
    ];

    const result = runMigrations(db, "test.db", migrations);

    // Version 1 should have been applied, version 2 should have failed
    assert.equal(result.currentVersion, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].version, 2);
    assert.equal(getSchemaVersion(db), 1);

    // The partially-applied column from the failed migration should be rolled back
    const cols = db.prepare("PRAGMA table_info(things)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    assert.ok(!colNames.includes("extra"), "Rolled-back column should not exist");

    // Original data intact
    const row = db.prepare("SELECT name FROM things").get() as { name: string };
    assert.equal(row.name, "original");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. KNOWLEDGE_BASE_MIGRATIONS version 2 adds chunk_type column
// ---------------------------------------------------------------------------
test("KNOWLEDGE_BASE_MIGRATIONS v2 adds chunk_type column to transcript_chunks", () => {
  const { db, dir } = tmpDb();
  try {
    // Create a minimal transcript_chunks table simulating the existing schema
    db.exec(`
      CREATE TABLE transcript_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        start_time REAL,
        end_time REAL
      )
    `);

    const result = runMigrations(db, "knowledge-base.sqlite", KNOWLEDGE_BASE_MIGRATIONS);

    assert.equal(result.currentVersion, 2);
    assert.equal(result.migrationsApplied.length, 2);
    assert.equal(result.errors.length, 0);

    // Verify the column was added
    const cols = db.prepare("PRAGMA table_info(transcript_chunks)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes("chunk_type"), "chunk_type column should exist");

    // Verify default value works
    db.prepare("INSERT INTO transcript_chunks (video_id, chunk_text) VALUES (?, ?)").run("v1", "hello");
    const row = db.prepare("SELECT chunk_type FROM transcript_chunks WHERE video_id = ?").get("v1") as { chunk_type: string };
    assert.equal(row.chunk_type, "transcript");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. KNOWLEDGE_BASE_MIGRATIONS version 2 is idempotent (safe to re-run)
// ---------------------------------------------------------------------------
test("KNOWLEDGE_BASE_MIGRATIONS v2 is idempotent — safe if column already exists", () => {
  const { db, dir } = tmpDb();
  try {
    // Create a table that already has the chunk_type column
    db.exec(`
      CREATE TABLE transcript_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        start_time REAL,
        end_time REAL,
        chunk_type TEXT NOT NULL DEFAULT 'transcript'
      )
    `);

    // Run migrations — v2 should detect the column exists and skip the ALTER
    const result = runMigrations(db, "knowledge-base.sqlite", KNOWLEDGE_BASE_MIGRATIONS);

    assert.equal(result.currentVersion, 2);
    assert.equal(result.errors.length, 0);

    // Column still works
    db.prepare("INSERT INTO transcript_chunks (video_id, chunk_text) VALUES (?, ?)").run("v1", "hello");
    const row = db.prepare("SELECT chunk_type FROM transcript_chunks WHERE video_id = ?").get("v1") as { chunk_type: string };
    assert.equal(row.chunk_type, "transcript");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 13. KNOWLEDGE_BASE_MIGRATIONS version 2 no-ops when transcript_chunks is absent
//     (the comment store may open the shared DB before the transcript store
//     has created the table).
// ---------------------------------------------------------------------------
test("KNOWLEDGE_BASE_MIGRATIONS v2 is safe when transcript_chunks does not exist", () => {
  const { db, dir } = tmpDb();
  try {
    const result = runMigrations(db, "knowledge-base.sqlite", KNOWLEDGE_BASE_MIGRATIONS);

    assert.equal(result.currentVersion, 2);
    assert.equal(result.errors.length, 0);

    // The migration must not have conjured the table into existence.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_chunks'")
      .get();
    assert.equal(table, undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
