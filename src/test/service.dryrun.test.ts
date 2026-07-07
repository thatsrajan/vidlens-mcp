import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { YouTubeService } from "../lib/youtube-service.js";

const dataDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-dryrun-"));
const service = new YouTubeService({ dryRun: true, dataDir });
const sampleVideo = "dQw4w9WgXcQ";
const sampleChannel = "@GoogleDevelopers";
const samplePlaylist = "PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4";

test("V1 and V2 tools return structured dry-run outputs", async () => {
  const [
    search,
    video,
    channel,
    catalog,
    transcript,
    comments,
    sentiment,
    videoSet,
    playlist,
    playlistAnalysis,
    playlistImport,
    videoImport,
    hooks,
    titleResearch,
    formatCompare,
    uploadWindows,
    importReadiness,
    dossier,
    systemHealth,
    visualIndex,
    visualSearch,
    similarFrames,
  ] = await Promise.all([
    service.findVideos({ query: "youtube mcp", maxResults: 3 }),
    service.inspectVideo({ videoIdOrUrl: sampleVideo }),
    service.inspectChannel({ channelIdOrHandleOrUrl: sampleChannel }),
    service.listChannelCatalog({ channelIdOrHandleOrUrl: sampleChannel, maxResults: 3 }),
    service.readTranscript({ videoIdOrUrl: sampleVideo, mode: "key_moments" }),
    service.readComments({ videoIdOrUrl: sampleVideo, maxTopLevel: 3 }),
    service.measureAudienceSentiment({ videoIdOrUrl: sampleVideo, sampleSize: 3 }),
    service.analyzeVideoSet({ videoIdsOrUrls: [sampleVideo], analyses: ["video_info", "transcript", "hook_patterns"] }),
    service.expandPlaylist({ playlistUrlOrId: samplePlaylist, maxVideos: 3 }),
    service.analyzePlaylist({ playlistUrlOrId: samplePlaylist, analyses: ["video_info", "hook_patterns"], maxVideos: 3 }),
    service.importPlaylist({ playlistUrlOrId: samplePlaylist, maxVideos: 2, label: "Dry Run Playlist" }),
    service.importVideos({ videoIdsOrUrls: [sampleVideo], label: "Dry Run Videos" }),
    service.scoreHookPatterns({ videoIdsOrUrls: [sampleVideo] }),
    service.researchTagsAndTitles({ seedTopic: "youtube hooks", maxExamples: 5 }),
    service.compareShortsVsLong({ channelIdOrHandleOrUrl: sampleChannel }),
    service.recommendUploadWindows({ channelIdOrHandleOrUrl: sampleChannel, timezone: "Australia/Sydney" }),
    service.checkImportReadiness({ videoIdOrUrl: sampleVideo }),
    service.buildVideoDossier({ videoIdOrUrl: sampleVideo, commentSampleSize: 3 }),
    service.checkSystemHealth(),
    service.indexVisualContent({ videoIdOrUrl: sampleVideo, maxFrames: 3 }),
    service.searchVisualContent({ query: "whiteboard framework", videoIdOrUrl: sampleVideo, maxResults: 2 }),
    service.findSimilarFrames({ assetId: "dry-frame-dQw4w9WgXcQ-2", maxResults: 1 }),
  ]);

  const activated = await service.setActiveCollection({ collectionId: videoImport.collectionId });
  const focusedSearch = await service.searchTranscripts({ query: "title research checklist", maxResults: 3 });
  const collectionList = await service.listCollections({ includeVideoList: true });
  const activeCollection = collectionList.activeCollectionId;
  const globalSearch = await service.searchTranscripts({ query: "title research checklist", maxResults: 3, useActiveCollection: false });
  const cleared = await service.clearActiveCollection();
  const searchAfterClear = await service.searchTranscripts({ query: "title research checklist", maxResults: 3 });

  assert.equal(search.provenance.sourceTier, "none");
  assert.equal(video.video.videoId, sampleVideo);
  assert.equal(channel.channel.title, "Dry-run channel");
  assert.equal(catalog.items.length > 0, true);
  assert.equal(transcript.transcript.mode, "key_moments");
  assert.equal(comments.threads.length, 3);
  assert.equal(typeof sentiment.sentiment.sentimentScore, "number");
  assert.equal(videoSet.processedCount, 1);
  assert.equal(playlist.playlist.playlistId, samplePlaylist);
  assert.equal(playlistAnalysis.run.processed > 0, true);
  assert.equal(playlistImport.import.imported > 0, true);
  assert.equal(videoImport.import.imported > 0, true);
  assert.equal(playlistImport.activeCollectionId, playlistImport.collectionId);
  assert.equal(videoImport.activeCollectionId, videoImport.collectionId);
  assert.equal(collectionList.collections.length >= 2, true);
  assert.equal(activated.activeCollectionId, videoImport.collectionId);
  assert.equal(activeCollection, videoImport.collectionId);
  assert.equal(focusedSearch.results.length > 0, true);
  assert.equal(focusedSearch.searchMeta.scope.mode, "active");
  assert.deepEqual(focusedSearch.searchMeta.scope.searchedCollectionIds, [videoImport.collectionId]);
  assert.equal(globalSearch.results.length > 0, true);
  assert.equal(globalSearch.searchMeta.scope.mode, "all_collections");
  assert.equal(cleared.cleared, true);
  assert.equal(searchAfterClear.searchMeta.scope.mode, "all_collections");
  assert.equal(hooks.videos[0]?.hookType !== undefined, true);
  assert.equal(titleResearch.examples.length > 0, true);
  assert.equal(formatCompare.recommendation.rationale.length > 0, true);
  assert.equal(uploadWindows.recommendedSlots.length > 0, true);
  assert.equal(importReadiness.importReadiness.canImport, true);
  assert.equal(importReadiness.transcript.available, true);
  assert.equal(dossier.video.videoId, sampleVideo);
  assert.equal(dossier.comments?.totalFetched, 3);
  assert.equal(dossier.audienceSentiment !== undefined, true);
  assert.equal(systemHealth.overallStatus, "ready");
  assert.equal(visualIndex.videoId, sampleVideo);
  assert.equal(visualIndex.indexing.framesIndexed, 3);
  assert.equal(visualIndex.indexing.embeddingProvider, "gemini");
  assert.equal(visualIndex.evidence.length, 3);
  assert.equal(visualSearch.results.length > 0, true);
  assert.equal(visualSearch.searchMeta.queryMode, "gemini_semantic_plus_lexical");
  assert.equal(visualSearch.searchMeta.embeddingProvider, "gemini");
  assert.equal(typeof visualSearch.results[0]?.lexicalScore, "number");
  assert.equal(typeof visualSearch.results[0]?.semanticScore, "number");
  assert.equal(similarFrames.results.length, 1);
  assert.equal(similarFrames.searchMeta.similarityEngine, "apple_vision_feature_print");

  // V3 Trends & Discovery dry-run
  const trends = await service.discoverNicheTrends({ niche: "AI coding tools" });
  assert.equal(trends.niche, "AI coding tools");
  assert.equal(trends.trendingVideos.length > 0, true);
  assert.ok(["accelerating", "steady", "decelerating", "insufficient_data"].includes(trends.momentum.recencyBias));
  assert.ok(["low", "medium", "high", "insufficient_data"].includes(trends.saturation.saturationLevel));
  assert.equal(Array.isArray(trends.contentGaps), true);
  assert.equal(Array.isArray(trends.recurringKeywords), true);
  assert.equal(Array.isArray(trends.titlePatterns), true);
  assert.equal(typeof trends.formatBreakdown.shortsPct, "number");
  assert.equal(trends.limitations.length > 0, true);
  assert.equal(trends.provenance.sourceTier, "none");

  const competitors = await service.exploreNicheCompetitors({ niche: "AI coding tools" });
  assert.equal(competitors.niche, "AI coding tools");
  assert.equal(competitors.competitors.length > 0, true);
  assert.equal(typeof competitors.landscape.totalChannelsSampled, "number");
  assert.equal(competitors.limitations.length > 0, true);
});

test("recallWorkspace returns a compact cross-session digest in dry-run", async () => {
  const recall = await service.recallWorkspace();

  assert.equal(recall.provenance.sourceTier, "none");
  assert.equal(typeof recall.hint, "string");
  assert.equal(recall.hint.length > 0, true);
  assert.equal(typeof recall.dataDir, "string");

  // Transcript collections
  assert.equal(typeof recall.transcriptCollections.count, "number");
  assert.equal(Array.isArray(recall.transcriptCollections.items), true);
  const collection = recall.transcriptCollections.items[0];
  assert.ok(collection);
  assert.equal(typeof collection.collectionId, "string");
  assert.equal(typeof collection.videoCount, "number");
  assert.equal(typeof collection.chunkCount, "number");
  assert.equal(typeof collection.embedding, "string");
  assert.equal(typeof collection.lastUpdatedAt, "string");
  assert.equal(typeof collection.isActive, "boolean");

  // Comment collections
  assert.equal(typeof recall.commentCollections.count, "number");
  assert.equal(Array.isArray(recall.commentCollections.items), true);
  assert.equal(typeof recall.commentCollections.items[0]?.commentChunkCount, "number");

  // Media store totals
  assert.equal(typeof recall.mediaStore.totalAssets, "number");
  assert.equal(typeof recall.mediaStore.totalSizeBytes, "number");
  assert.equal(typeof recall.mediaStore.videoCount, "number");
  assert.equal(typeof recall.mediaStore.byKind, "object");

  // Visual index summary (present in the dry-run fixture)
  assert.ok(recall.visualIndex);
  assert.equal(typeof recall.visualIndex.indexedVideoCount, "number");
  assert.equal(typeof recall.visualIndex.totalFrames, "number");
});
