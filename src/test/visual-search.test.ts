import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MediaStore } from "../lib/media-store.js";
import { MediaDownloader } from "../lib/media-downloader.js";
import { ThumbnailExtractor, computeSampleTimestamps } from "../lib/thumbnail-extractor.js";
import { VisualIndexStore, VisualSearchEngine, coverageRatio, VISUAL_COVERAGE_THRESHOLD } from "../lib/visual-search.js";
import { MacOSVisionAnalyzer } from "../lib/macos-vision.js";

function createFixtureFile(dir: string, name: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, "fixture");
  return filePath;
}

test("visual search ranks OCR and description-backed matches with image evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "vidlens-visual-test-"));
  const framesDir = join(root, "frames");
  mkdirSync(framesDir, { recursive: true });

  const mediaStore = new MediaStore({ dataDir: root });
  const visualStore = new VisualIndexStore({ dataDir: root });
  const engine = new VisualSearchEngine(
    mediaStore,
    new MediaDownloader(mediaStore),
    new ThumbnailExtractor(mediaStore),
    { dataDir: root, store: visualStore },
  );

  const firstFrame = createFixtureFile(framesDir, "frame-1.jpg");
  const secondFrame = createFixtureFile(framesDir, "frame-2.jpg");

  visualStore.upsertFrame({
    videoId: "video1234567",
    frameAssetId: "asset-1",
    framePath: firstFrame,
    timestampSec: 12,
    sourceVideoUrl: "https://www.youtube.com/watch?v=video1234567",
    sourceVideoTitle: "Architecture walkthrough",
    ocrText: "SYSTEM ARCHITECTURE OVERVIEW",
    visualDescription: "A whiteboard architecture diagram with service boxes and arrows.",
    featureVector: [1, 0, 0],
    descriptionModel: "gemini-2.5-flash",
  });

  visualStore.upsertFrame({
    videoId: "video1234567",
    frameAssetId: "asset-2",
    framePath: secondFrame,
    timestampSec: 48,
    sourceVideoUrl: "https://www.youtube.com/watch?v=video1234567",
    sourceVideoTitle: "Architecture walkthrough",
    ocrText: "ENGAGEMENT DASHBOARD",
    visualDescription: "A metrics dashboard showing retention and comments charts.",
    featureVector: [0.8, 0.2, 0],
    descriptionModel: "gemini-2.5-flash",
  });

  const search = await engine.searchText({ query: "architecture diagram", videoId: "video1234567", autoIndexIfNeeded: false });
  assert.equal(search.results.length > 0, true);
  assert.equal(search.results[0]?.frameAssetId, "asset-1");
  assert.equal(search.results[0]?.framePath, firstFrame);
  assert.equal(search.results[0]?.matchedOn.includes("description"), true);

  const similar = await engine.findSimilarFrames({ assetId: "asset-1", videoId: "video1234567", minSimilarity: 0.1 });
  assert.equal(similar.results.length, 1);
  assert.equal(similar.results[0]?.frameAssetId, "asset-2");
  assert.equal(similar.results[0]?.framePath, secondFrame);
});

test("short videos sample every intervalSec from t=0 (interval fits the frame budget)", () => {
  const timestamps = computeSampleTimestamps(240, 20, 12);
  assert.deepEqual(timestamps, [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220]);
});

test("long videos spread the frame budget across the full duration, not just the first minutes", () => {
  const durationSec = 1200; // 20 minutes — the old t=0 walk only reached 240s
  const maxFrames = 12;
  const timestamps = computeSampleTimestamps(durationSec, 20, maxFrames);

  assert.equal(timestamps.length, maxFrames);
  assert.equal(timestamps[0], 0);
  // Last sampled frame lands near the end, not at maxFrames*intervalSec (=240s).
  assert.ok(timestamps[timestamps.length - 1]! >= durationSec * 0.9, "last frame should be near the end");

  // The coverage check must AGREE with the sampler: a completed index of this long video passes.
  const minSec = timestamps[0]!;
  const maxSec = timestamps[timestamps.length - 1]!;
  assert.ok(
    coverageRatio(minSec, maxSec, durationSec) >= VISUAL_COVERAGE_THRESHOLD,
    "spread sampling must clear the auto-reindex coverage threshold",
  );

  // Sanity: the OLD t=0-only walk (240s span) would have failed the same threshold.
  assert.ok(coverageRatio(0, 240, durationSec) < VISUAL_COVERAGE_THRESHOLD);
});

test("computeSampleTimestamps handles degenerate inputs without throwing", () => {
  assert.deepEqual(computeSampleTimestamps(0, 20, 12), []);
  assert.deepEqual(computeSampleTimestamps(600, 0, 12), []);
  assert.deepEqual(computeSampleTimestamps(600, 20, 0), []);
});

test("Apple Vision batch tolerates unreadable frames instead of aborting the whole batch", async () => {
  const analyzer = new MacOSVisionAnalyzer();
  const batch = await analyzer.analyzeFramesBatch([
    join(tmpdir(), `vidlens-missing-${Date.now()}-a.jpg`),
    join(tmpdir(), `vidlens-missing-${Date.now()}-b.jpg`),
  ]);
  // No swift invocation happens (all frames missing), and no throw — failures are surfaced.
  assert.equal(batch.analyses.length, 0);
  assert.equal(batch.failures.length, 2);
  assert.ok(batch.failures.every((f) => f.error.includes("does not exist")));
});
