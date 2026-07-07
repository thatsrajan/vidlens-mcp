import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { YouTubeService } from "../lib/youtube-service.js";
import { TranscriptKnowledgeBase, type ImportTranscriptItem } from "../lib/knowledge-base.js";
import { selectionToAlgorithm } from "../lib/embedding-provider.js";
import { getSchemaVersion } from "../lib/schema-migration.js";

function transcriptItem(videoId: string, text: string): ImportTranscriptItem {
  return {
    video: {
      videoId,
      title: `Video ${videoId}`,
      channelTitle: "vidlens-mcp",
      url: `https://www.youtube.com/watch?v=${videoId}`,
    },
    transcript: {
      videoId,
      sourceType: "manual_caption",
      transcriptText: text,
      segments: [{ tStartSec: 0, tEndSec: 8, text }],
    },
    options: { strategy: "time_window", chunkSizeSec: 120, chunkOverlapSec: 30 },
  };
}

test("knowledge-base flow imports, searches, lists, and removes collections", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-kb-"));
  const service = new YouTubeService({ dryRun: true, dataDir });
  const playlistId = "PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4";

  const imported = await service.importPlaylist({
    playlistUrlOrId: playlistId,
    maxVideos: 2,
    label: "Stanford-ish Playlist",
  });

  assert.equal(imported.collectionId, `playlist-${playlistId}`);
  assert.equal(imported.import.imported, 2);
  assert.equal(imported.import.chunksCreated > 0, true);
  assert.equal(imported.activeCollectionId, imported.collectionId);

  const search = await service.searchTranscripts({
    query: "title patterns and checklist",
    maxResults: 5,
  });

  assert.equal(search.results.length > 0, true);
  assert.equal(search.results[0]?.timestampUrl.includes("youtu.be/"), true);
  assert.equal(search.searchMeta.totalChunksSearched > 0, true);
  assert.equal(search.searchMeta.scope.mode, "active");
  assert.deepEqual(search.searchMeta.scope.searchedCollectionIds, [imported.collectionId]);

  const collections = await service.listCollections({ includeVideoList: true });
  const target = collections.collections.find((item) => item.collectionId === imported.collectionId);
  assert.equal(Boolean(target), true);
  assert.equal(collections.activeCollectionId, imported.collectionId);
  assert.equal(target?.isActive, true);
  assert.equal(target?.videoCount, 2);
  assert.equal((target?.videos?.length ?? 0) > 0, true);

  const removed = await service.removeCollection({ collectionId: imported.collectionId });
  assert.equal(removed.removed, true);
  assert.equal(removed.chunksDeleted > 0, true);
  assert.equal(removed.clearedActiveCollection, true);

  const afterDelete = await service.listCollections();
  assert.equal(afterDelete.collections.some((item) => item.collectionId === imported.collectionId), false);
  assert.equal(afterDelete.activeCollectionId, undefined);
});

test("incremental import into a gemini collection does not silently downgrade embeddings (WS2-1)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-kb-gemini-"));
  const collectionId = "gemini-collection";
  const dbPath = join(dataDir, "knowledge-base.sqlite");

  // Import video A under the local model.
  const kb = new TranscriptKnowledgeBase({ dataDir });
  kb.importVideos(
    { collectionId, sourceType: "videos", label: "Gemini demo" },
    [transcriptItem("aaaaaaaaaaa", "Alpha transcript about search ranking and retrieval quality tonight.")],
  );
  kb.close();

  // Simulate the collection having been built with Gemini: rewrite the model
  // row to the gemini algorithm and stamp every chunk with a fixed fake vector.
  const geminiAlgorithm = selectionToAlgorithm({ kind: "gemini", model: "gemini-embedding-001", dimensions: 768 });
  const fakeEmbedding = JSON.stringify([0.1, 0.2, 0.3, 0.4]);
  const seed = new DatabaseSync(dbPath);
  seed.prepare("UPDATE collection_models SET algorithm = ?, sigma_json = ? WHERE collection_id = ?")
    .run(geminiAlgorithm, JSON.stringify([]), collectionId);
  seed.prepare("UPDATE transcript_chunks SET embedding_json = ? WHERE collection_id = ?")
    .run(fakeEmbedding, collectionId);
  const aChunkIds = (seed.prepare("SELECT chunk_id FROM transcript_chunks WHERE collection_id = ? AND video_id = ?")
    .all(collectionId, "aaaaaaaaaaa") as Array<{ chunk_id: string }>).map((row) => row.chunk_id);
  seed.close();
  assert.equal(aChunkIds.length > 0, true);

  // Import video B into the same collection under the local model (no Gemini env).
  const kb2 = new TranscriptKnowledgeBase({ dataDir });
  kb2.importVideos(
    { collectionId, sourceType: "videos" },
    [transcriptItem("bbbbbbbbbbb", "Beta transcript about video hooks and audience retention tonight.")],
  );
  // The stored algorithm must remain gemini — never silently reset to local.
  assert.equal(kb2.collectionEmbeddingSelection(collectionId)?.kind, "gemini");
  kb2.close();

  const verify = new DatabaseSync(dbPath);
  // Video A's paid embeddings are preserved verbatim.
  for (const chunkId of aChunkIds) {
    const row = verify.prepare("SELECT embedding_json FROM transcript_chunks WHERE chunk_id = ?")
      .get(chunkId) as { embedding_json: string | null };
    assert.equal(row.embedding_json, fakeEmbedding);
  }
  // Video B's new chunks are left unembedded (awaiting a gemini reindex) rather
  // than overwritten with local LSA vectors — no silent downgrade.
  const bRows = verify.prepare("SELECT embedding_json FROM transcript_chunks WHERE collection_id = ? AND video_id = ?")
    .all(collectionId, "bbbbbbbbbbb") as Array<{ embedding_json: string | null }>;
  assert.equal(bRows.length > 0, true);
  for (const row of bRows) {
    assert.equal(row.embedding_json, null);
  }
  // The model row still reports gemini.
  const model = verify.prepare("SELECT algorithm FROM collection_models WHERE collection_id = ?")
    .get(collectionId) as { algorithm: string };
  assert.equal(model.algorithm, geminiAlgorithm);
  verify.close();
});

test("constructor migrates a legacy knowledge-base.sqlite (WS1-3)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-kb-legacy-"));
  const dbPath = join(dataDir, "knowledge-base.sqlite");

  // Build a pre-migration (v0) database: transcript_chunks without chunk_type,
  // collection_videos without the newer source columns, user_version = 0.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE collections (
      collection_id TEXT PRIMARY KEY, label TEXT, source_type TEXT NOT NULL, source_ref TEXT,
      source_title TEXT, source_channel_title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE collection_videos (
      collection_id TEXT NOT NULL, video_id TEXT NOT NULL, title TEXT, channel_title TEXT,
      published_at TEXT, transcript_language TEXT, transcript_source_type TEXT, url TEXT,
      transcript_characters INTEGER, transcript_segments INTEGER, imported_at TEXT NOT NULL,
      PRIMARY KEY (collection_id, video_id)
    );
    CREATE TABLE transcript_chunks (
      chunk_id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, video_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, t_start_sec REAL NOT NULL, t_end_sec REAL, text TEXT NOT NULL,
      token_count INTEGER NOT NULL, terms_json TEXT NOT NULL, doc_norm REAL, embedding_json TEXT
    );
  `);
  legacy.prepare("INSERT INTO collections (collection_id, source_type, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("legacy", "videos", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  legacy.prepare("INSERT INTO collection_videos (collection_id, video_id, imported_at) VALUES (?, ?, ?)")
    .run("legacy", "legacyVid001", "2026-01-01T00:00:00Z");
  assert.equal(getSchemaVersion(legacy), 0);
  legacy.close();

  // Opening the store must migrate the schema in place.
  const kb = new TranscriptKnowledgeBase({ dataDir });
  kb.close();

  const verify = new DatabaseSync(dbPath);
  assert.equal(getSchemaVersion(verify), 2);
  const cols = (verify.prepare("PRAGMA table_info(transcript_chunks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("chunk_type"), "chunk_type column should be added");
  // Legacy backfill from the constructor still ran (source_platform added + set).
  const videoCols = (verify.prepare("PRAGMA table_info(collection_videos)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(videoCols.includes("canonical_url"));
  verify.close();
});
