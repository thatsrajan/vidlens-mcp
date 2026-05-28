import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MediaStore } from "../lib/media-store.js";

function createTempStore(): { store: MediaStore; dir: string } {
  const dir = join(tmpdir(), `ytmcp-media-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const store = new MediaStore({ dataDir: dir });
  return { store, dir };
}

function createFakeFile(dir: string, name: string, sizeBytes = 1024): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(sizeBytes, 0x42));
  return path;
}

test("MediaStore: register and retrieve an asset", () => {
  const { store, dir } = createTempStore();
  try {
    const filePath = createFakeFile(join(dir, "files", "abc123"), "abc123.mp4", 2048);

    const asset = store.registerAsset({
      videoId: "abc123",
      kind: "video",
      filePath,
      durationSec: 120,
    });

    assert.ok(asset.assetId, "should have an asset ID");
    assert.equal(asset.videoId, "abc123");
    assert.equal(asset.kind, "video");
    assert.equal(asset.fileSizeBytes, 2048);
    assert.equal(asset.mimeType, "video/mp4");
    assert.equal(asset.durationSec, 120);

    // Retrieve by ID
    const fetched = store.getAsset(asset.assetId);
    assert.ok(fetched);
    assert.equal(fetched.assetId, asset.assetId);
    assert.equal(fetched.videoId, "abc123");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: list assets for video", () => {
  const { store, dir } = createTempStore();
  try {
    const videoDir = join(dir, "files", "vid1");
    const f1 = createFakeFile(videoDir, "vid1.mp4", 5000);
    const f2 = createFakeFile(videoDir, "vid1-thumb.jpg", 500);

    store.registerAsset({ videoId: "vid1", kind: "video", filePath: f1 });
    store.registerAsset({ videoId: "vid1", kind: "thumbnail", filePath: f2 });

    const assets = store.listAssetsForVideo("vid1");
    assert.equal(assets.length, 2);

    const kinds = assets.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["thumbnail", "video"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: list all assets with kind filter", () => {
  const { store, dir } = createTempStore();
  try {
    const d1 = join(dir, "files", "v1");
    const d2 = join(dir, "files", "v2");
    store.registerAsset({ videoId: "v1", kind: "video", filePath: createFakeFile(d1, "v1.mp4") });
    store.registerAsset({ videoId: "v1", kind: "audio", filePath: createFakeFile(d1, "v1.m4a") });
    store.registerAsset({ videoId: "v2", kind: "video", filePath: createFakeFile(d2, "v2.mp4") });

    const videos = store.listAllAssets({ kind: "video" });
    assert.equal(videos.length, 2);

    const audio = store.listAllAssets({ kind: "audio" });
    assert.equal(audio.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: getStats returns correct counts", () => {
  const { store, dir } = createTempStore();
  try {
    const d1 = join(dir, "files", "v1");
    store.registerAsset({ videoId: "v1", kind: "video", filePath: createFakeFile(d1, "v1.mp4", 3000) });
    store.registerAsset({ videoId: "v1", kind: "thumbnail", filePath: createFakeFile(d1, "v1.jpg", 200) });
    store.registerAsset({ videoId: "v2", kind: "audio", filePath: createFakeFile(join(dir, "files", "v2"), "v2.m4a", 800) });

    const stats = store.getStats();
    assert.equal(stats.totalAssets, 3);
    assert.equal(stats.totalSizeBytes, 4000);
    assert.equal(stats.videoCount, 2);
    assert.equal(stats.byKind.video, 1);
    assert.equal(stats.byKind.thumbnail, 1);
    assert.equal(stats.byKind.audio, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: remove single asset deletes file", () => {
  const { store, dir } = createTempStore();
  try {
    const filePath = createFakeFile(join(dir, "files", "v1"), "v1.mp4", 1000);
    const asset = store.registerAsset({ videoId: "v1", kind: "video", filePath });

    assert.ok(existsSync(filePath));
    const removed = store.removeAsset(asset.assetId, true);
    assert.ok(removed);
    assert.ok(!existsSync(filePath));
    assert.equal(store.getAsset(asset.assetId), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: remove all assets for video", () => {
  const { store, dir } = createTempStore();
  try {
    const d1 = join(dir, "files", "v1");
    const f1 = createFakeFile(d1, "v1.mp4", 2000);
    const f2 = createFakeFile(d1, "v1-thumb.jpg", 300);
    store.registerAsset({ videoId: "v1", kind: "video", filePath: f1 });
    store.registerAsset({ videoId: "v1", kind: "thumbnail", filePath: f2 });

    const count = store.removeVideoAssets("v1", true);
    assert.equal(count, 2);
    assert.ok(!existsSync(f1));
    assert.ok(!existsSync(f2));
    assert.equal(store.listAssetsForVideo("v1").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: getVideoSummary aggregates correctly", () => {
  const { store, dir } = createTempStore();
  try {
    const d1 = join(dir, "files", "v1");
    store.registerAsset({ videoId: "v1", kind: "video", filePath: createFakeFile(d1, "v1.mp4", 5000) });
    store.registerAsset({ videoId: "v1", kind: "audio", filePath: createFakeFile(d1, "v1.m4a", 1000) });

    const summary = store.getVideoSummary("v1");
    assert.equal(summary.videoId, "v1");
    assert.equal(summary.assets.length, 2);
    assert.equal(summary.totalSizeBytes, 6000);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: mime type guessing", () => {
  const { store, dir } = createTempStore();
  try {
    const d = join(dir, "files", "v1");
    const mp4 = store.registerAsset({ videoId: "v1", kind: "video", filePath: createFakeFile(d, "v1.mp4") });
    assert.equal(mp4.mimeType, "video/mp4");

    const m4a = store.registerAsset({ videoId: "v1", kind: "audio", filePath: createFakeFile(d, "v1.m4a") });
    assert.equal(m4a.mimeType, "audio/mp4");

    const jpg = store.registerAsset({ videoId: "v1", kind: "thumbnail", filePath: createFakeFile(d, "v1.jpg") });
    assert.equal(jpg.mimeType, "image/jpeg");

    const webp = store.registerAsset({ videoId: "v1", kind: "keyframe", filePath: createFakeFile(d, "v1.webp") });
    assert.equal(webp.mimeType, "image/webp");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: register with metadata JSON", () => {
  const { store, dir } = createTempStore();
  try {
    const d = join(dir, "files", "v1");
    const asset = store.registerAsset({
      videoId: "v1",
      kind: "keyframe",
      filePath: createFakeFile(d, "frame.jpg"),
      timestampSec: 42.5,
      width: 640,
      height: 360,
      meta: { source: "ffmpeg", quality: "high" },
    });

    assert.equal(asset.timestampSec, 42.5);
    assert.equal(asset.width, 640);
    assert.equal(asset.height, 360);
    assert.deepEqual(asset.meta, { source: "ffmpeg", quality: "high" });

    // Verify round-trip from DB
    const fetched = store.getAsset(asset.assetId);
    assert.ok(fetched);
    assert.equal(fetched.timestampSec, 42.5);
    assert.deepEqual(fetched.meta, { source: "ffmpeg", quality: "high" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaStore: source metadata round-trips without breaking legacy videoId", () => {
  const { store, dir } = createTempStore();
  try {
    const d = join(dir, "files", "x_123");
    const asset = store.registerAsset({
      videoId: "x_123",
      sourcePlatform: "x",
      sourceUrl: "https://x.com/openai/status/123",
      sourceId: "123",
      canonicalUrl: "https://x.com/openai/status/123",
      kind: "video",
      filePath: createFakeFile(d, "x_123.mp4"),
    });

    const fetched = store.getAsset(asset.assetId);
    assert.ok(fetched);
    assert.equal(fetched.videoId, "x_123");
    assert.equal(fetched.sourcePlatform, "x");
    assert.equal(fetched.sourceUrl, "https://x.com/openai/status/123");
    assert.equal(fetched.sourceId, "123");
    assert.equal(fetched.canonicalUrl, "https://x.com/openai/status/123");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
