import assert from "node:assert/strict";
import test from "node:test";
import { tools } from "../server/mcp-server.js";

test("public MCP surface uses intent-based tool names", () => {
  const toolNames = tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "findVideos",
    "inspectVideo",
    "inspectChannel",
    "listChannelCatalog",
    "readTranscript",
    "readComments",
    "measureAudienceSentiment",
    "analyzeVideoSet",
    "expandPlaylist",
    "analyzePlaylist",
    "importPlaylist",
    "importVideos",
    "searchTranscripts",
    "listCollections",
    "setActiveCollection",
    "clearActiveCollection",
    "checkImportReadiness",
    "buildVideoDossier",
    "checkSystemHealth",
    "removeCollection",
    "scoreHookPatterns",
    "researchTagsAndTitles",
    "compareShortsVsLong",
    "recommendUploadWindows",
    // Trends & Discovery
    "discoverNicheTrends",
    "exploreNicheCompetitors",
    // Media / Asset tools
    "downloadAsset",
    "listMediaAssets",
    "removeMediaAsset",
    "extractKeyframes",
    "mediaStoreHealth",
    // Visual Search
    "indexVisualContent",
    "searchVisualContent",
    "findSimilarFrames",
    // Comment Knowledge Base
    "importComments",
    "searchComments",
    "listCommentCollections",
    "setActiveCommentCollection",
    "clearActiveCommentCollection",
    "removeCommentCollection",
    // Explore
    "exploreYouTube",
  ]);
});

test("media and visual tools have correct required fields", () => {
  const downloadTool = tools.find((t) => t.name === "downloadAsset");
  assert.ok(downloadTool, "downloadAsset tool should exist");
  assert.deepEqual(
    (downloadTool.inputSchema as any).required,
    ["videoIdOrUrl", "format"],
  );

  const extractTool = tools.find((t) => t.name === "extractKeyframes");
  assert.ok(extractTool, "extractKeyframes tool should exist");
  assert.deepEqual(
    (extractTool.inputSchema as any).required,
    ["videoIdOrUrl"],
  );

  const listTool = tools.find((t) => t.name === "listMediaAssets");
  assert.ok(listTool, "listMediaAssets tool should exist");
  assert.equal((listTool.inputSchema as any).required, undefined);

  const healthTool = tools.find((t) => t.name === "mediaStoreHealth");
  assert.ok(healthTool, "mediaStoreHealth tool should exist");
  assert.equal((healthTool.inputSchema as any).required, undefined);

  const indexTool = tools.find((t) => t.name === "indexVisualContent");
  assert.ok(indexTool, "indexVisualContent tool should exist");
  assert.deepEqual((indexTool.inputSchema as any).required, ["videoIdOrUrl"]);

  const searchTool = tools.find((t) => t.name === "searchVisualContent");
  assert.ok(searchTool, "searchVisualContent tool should exist");
  assert.deepEqual((searchTool.inputSchema as any).required, ["query"]);

  const similarTool = tools.find((t) => t.name === "findSimilarFrames");
  assert.ok(similarTool, "findSimilarFrames tool should exist");
  assert.equal((similarTool.inputSchema as any).required, undefined);
});
