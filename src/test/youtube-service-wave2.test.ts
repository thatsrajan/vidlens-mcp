import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import { YouTubeService } from "../lib/youtube-service.js";

const dataDir = mkdtempSync(join(tmpdir(), "vidlens-wave2-"));
const service = new YouTubeService({ dryRun: true, dataDir });
const samplePlaylist = "PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4";

test("recommendUploadWindows rejects an invalid timezone as INVALID_INPUT (WS4-7)", async () => {
  await assert.rejects(
    () => service.recommendUploadWindows({ channelIdOrHandleOrUrl: "@GoogleDevelopers", timezone: "Not/AZone" }),
    (error: any) => {
      assert.equal(error?.detail?.code ?? error?.code, "INVALID_INPUT");
      return true;
    },
  );

  // A valid IANA zone passes validation and resolves normally.
  const ok = await service.recommendUploadWindows({ channelIdOrHandleOrUrl: "@GoogleDevelopers", timezone: "America/New_York" });
  assert.ok(Array.isArray(ok.recommendedSlots));
});

test("expandPlaylist omits video metadata when includeVideoMeta is false (WS1-5)", async () => {
  const withMeta = await service.expandPlaylist({ playlistUrlOrId: samplePlaylist, maxVideos: 3, includeVideoMeta: true });
  assert.ok(withMeta.videos[0]?.title, "metadata should be present when includeVideoMeta is true");

  const withoutMeta = await service.expandPlaylist({ playlistUrlOrId: samplePlaylist, maxVideos: 3, includeVideoMeta: false });
  assert.ok(withoutMeta.videos.length > 0);
  for (const video of withoutMeta.videos) {
    assert.ok(video.videoId, "videoId is always retained");
    assert.equal(video.title, undefined);
    assert.equal(video.publishedAt, undefined);
    assert.equal(video.channelTitle, undefined);
  }
});

test("importVideos accepts a non-YouTube URL without an explicit collectionId (WS4-7)", async () => {
  // Previously threw because defaultVideoCollectionId ran requireVideoId (YouTube-only).
  const output = await service.importVideos({
    videoIdsOrUrls: ["https://www.tiktok.com/@vidlens/video/7350000000000000000"],
  });
  assert.ok(output.collectionId, "a default collection id should be derived from the source identity");
  assert.ok(output.import.imported > 0, "the non-YouTube source should be imported in dry-run");
});

test("searchVideoSources returns results with unique assetKeys (WS4-6)", async () => {
  const output = await service.searchVideoSources({
    query: "agent coding tools",
    platforms: ["youtube", "tiktok", "instagram", "x", "generic_url"],
    maxResults: 10,
  });
  const keys = output.results.map((r) => r.assetKey);
  assert.equal(keys.length, new Set(keys).size, "result assetKeys should be deduped");
});

test("reindexAfterImport fires for stored-Gemini collections and surfaces key errors as warnings", async () => {
  const svc = new YouTubeService({ dryRun: true, dataDir }) as any;
  const missingKey = () => Promise.reject(new Error("Gemini embedding provider selected but GEMINI_API_KEY/GOOGLE_API_KEY is not set."));

  // Stored collection is Gemini but the request is local (no key): reindex still
  // fires (via stored algorithm) and the key error becomes a non-fatal warning.
  svc._knowledgeBase = {
    collectionEmbeddingSelection: () => ({ kind: "gemini", model: "m", dimensions: 768 }),
    reindexCollectionEmbeddings: missingKey,
  };
  const warnings = await svc.reindexAfterImport("coll", 3, { kind: "local" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Gemini embedding did not run/);

  // A local collection with a local request never reindexes.
  let reindexCalled = false;
  svc._knowledgeBase = {
    collectionEmbeddingSelection: () => ({ kind: "local" }),
    reindexCollectionEmbeddings: async () => { reindexCalled = true; },
  };
  assert.deepEqual(await svc.reindexAfterImport("coll", 3, { kind: "local" }), []);
  assert.equal(reindexCalled, false);

  // Nothing imported → skip entirely (no collection lookup, no warning).
  svc._knowledgeBase = {
    collectionEmbeddingSelection: () => { throw new Error("should not be called when imported === 0"); },
    reindexCollectionEmbeddings: async () => {},
  };
  assert.deepEqual(await svc.reindexAfterImport("coll", 0, { kind: "gemini" }), []);

  // Successful reindex returns no warnings.
  svc._knowledgeBase = {
    collectionEmbeddingSelection: () => ({ kind: "gemini", model: "m", dimensions: 768 }),
    reindexCollectionEmbeddings: async () => {},
  };
  assert.deepEqual(await svc.reindexAfterImport("coll", 2, { kind: "gemini" }), []);
});

test("startEnrichmentJob dedupes in-flight jobs and records terminal status (WS4-4)", async () => {
  const svc = new YouTubeService({ dryRun: true, dataDir }) as any;

  let releaseRun: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const job1 = svc.startEnrichmentJob("transcript_search:coll", "transcript_search", ["a", "b"], () => gate);
  const job2 = svc.startEnrichmentJob("transcript_search:coll", "transcript_search", ["a", "b"], () => Promise.resolve());
  assert.equal(job1, job2, "an in-flight job must be reused, not duplicated");
  assert.equal(job1.status, "preparing");

  releaseRun();
  await gate;
  await flush();
  assert.equal(job1.status, "done");

  // A completed job is also reused (no duplicate downloads on repeat calls).
  const jobAfterDone = svc.startEnrichmentJob("transcript_search:coll", "transcript_search", ["a", "b"], () => Promise.reject(new Error("should not run")));
  assert.equal(jobAfterDone, job1);
  assert.equal(jobAfterDone.status, "done");

  // A failing job records a redacted error and can be retried.
  const failing = svc.startEnrichmentJob("visual_search:v", "visual_search", ["v"], () => Promise.reject(new Error("Cookie: secret=abc123 boom")));
  await flush();
  assert.equal(failing.status, "failed");
  assert.ok(failing.error, "a failed job should record an error summary");
  assert.equal(failing.error.includes("secret=abc123"), false, "the error summary must be redacted");
});
