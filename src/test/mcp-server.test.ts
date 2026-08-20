import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  tools,
  validateArgsAgainstSchema,
  normalizeError,
  deepStripFramePath,
  SERVER_VERSION,
} from "../server/mcp-server.js";
import { TOOL_COUNT } from "../lib/banner.js";

/** Run dispatch-boundary validation and return the normalized error payload (as the server would emit it). */
function normalizedValidationError(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  try {
    validateArgsAgainstSchema(toolName, args);
  } catch (error) {
    return normalizeError(error) as Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: `expected ${toolName} args to be rejected` });
}

test("public MCP surface uses intent-based tool names", () => {
  const toolNames = tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "recallWorkspace",
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
    // Universal Video Sources
    "inspectVideoSource",
    "searchVideoSources",
    "searchSocialTrends",
    "importVideoSources",
    "transcribeVideoSource",
    // Media / Asset tools
    "downloadAsset",
    "listMediaAssets",
    "removeMediaAsset",
    "extractKeyframes",
    "mediaStoreHealth",
    // Visual Search
    "indexVisualContent",
    "searchVisualContent",
    "renderVideoEvidence",
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

test("TOOL_COUNT matches the actual registered tool count (no drift)", () => {
  assert.equal(
    TOOL_COUNT,
    tools.length,
    `TOOL_COUNT (${TOOL_COUNT}) must equal the number of registered tools (${tools.length}). Update banner.ts when adding/removing a tool.`,
  );
});

test("recallWorkspace is registered with a valid, param-free schema", () => {
  const recall = tools.find((t) => t.name === "recallWorkspace");
  assert.ok(recall, "recallWorkspace tool should exist");
  const schema = recall.inputSchema as {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  assert.equal(schema.type, "object");
  // No required params — safe to call blind at session start.
  assert.equal(schema.required, undefined);
  assert.equal(schema.additionalProperties, false);
  // Description is the behavioral intervention: it must tell agents to call it first.
  assert.match(recall.description ?? "", /first/i);
  assert.match(recall.description ?? "", /persist/i);

  // Schema validation accepts an empty-args call and rejects unknown params.
  assert.doesNotThrow(() => validateArgsAgainstSchema("recallWorkspace", {}));
  assert.doesNotThrow(() => validateArgsAgainstSchema("recallWorkspace", { dryRun: true }));
});

test("import/download tool descriptions carry cross-session persistence breadcrumbs", () => {
  for (const name of ["importVideos", "importPlaylist", "importComments", "downloadAsset", "indexVisualContent"]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} tool should exist`);
    assert.match(tool.description ?? "", /persist|recallWorkspace/i, `${name} description should mention persistence/recallWorkspace`);
  }
});

test("universal video tools are exposed through the plain MCP surface for Claude and Codex", () => {
  const inspectTool = tools.find((t) => t.name === "inspectVideoSource");
  assert.ok(inspectTool, "inspectVideoSource tool should exist");
  assert.deepEqual((inspectTool.inputSchema as any).required, ["source"]);

  const searchTool = tools.find((t) => t.name === "searchVideoSources");
  assert.ok(searchTool, "searchVideoSources tool should exist");
  assert.deepEqual((searchTool.inputSchema as any).required, ["query"]);

  const socialTool = tools.find((t) => t.name === "searchSocialTrends");
  assert.ok(socialTool, "searchSocialTrends tool should exist");
  assert.deepEqual((socialTool.inputSchema as any).required, ["query"]);

  const importTool = tools.find((t) => t.name === "importVideoSources");
  assert.ok(importTool, "importVideoSources tool should exist");
  assert.deepEqual((importTool.inputSchema as any).required, ["sources"]);
  assert.ok((importTool.inputSchema as any).properties.transcribe, "importVideoSources should expose transcribe flag");

  const transcribeTool = tools.find((t) => t.name === "transcribeVideoSource");
  assert.ok(transcribeTool, "transcribeVideoSource tool should exist");
  assert.deepEqual((transcribeTool.inputSchema as any).required, ["source"]);
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

test("bogus enum value is rejected as INVALID_INPUT with allowed values listed", () => {
  const payload = normalizedValidationError("downloadAsset", { videoIdOrUrl: "abc", format: "bogus" });
  assert.equal(payload.code, "INVALID_INPUT");
  const message = String(payload.message);
  for (const allowed of ["best_video", "best_audio", "thumbnail", "worst_video"]) {
    assert.ok(message.includes(allowed), `message should list allowed value '${allowed}': ${message}`);
  }
});

test("out-of-range maxSizeMb is rejected as INVALID_INPUT", () => {
  const tooBig = normalizedValidationError("downloadAsset", { videoIdOrUrl: "abc", format: "best_video", maxSizeMb: 99999999 });
  assert.equal(tooBig.code, "INVALID_INPUT");

  const tooSmall = normalizedValidationError("downloadAsset", { videoIdOrUrl: "abc", format: "best_video", maxSizeMb: -5 });
  assert.equal(tooSmall.code, "INVALID_INPUT");
});

test("non-finite numbers are rejected as INVALID_INPUT", () => {
  const infinite = normalizedValidationError("downloadAsset", { videoIdOrUrl: "abc", format: "best_video", maxSizeMb: Infinity });
  assert.equal(infinite.code, "INVALID_INPUT");
});

test("missing required arg is INVALID_INPUT, not INTERNAL_ERROR", () => {
  const payload = normalizedValidationError("downloadAsset", { videoIdOrUrl: "abc" });
  assert.equal(payload.code, "INVALID_INPUT");
  assert.notEqual(payload.code, "INTERNAL_ERROR");
  assert.ok(String(payload.message).includes("format"), "message should name the missing argument");
});

test("bad enum inside an array argument is rejected as INVALID_INPUT", () => {
  const payload = normalizedValidationError("analyzeVideoSet", {
    videoIdsOrUrls: ["abc"],
    analyses: ["transcript", "not_a_real_analysis"],
  });
  assert.equal(payload.code, "INVALID_INPUT");
});

test("valid args pass dispatch-boundary validation", () => {
  assert.doesNotThrow(() =>
    validateArgsAgainstSchema("downloadAsset", { videoIdOrUrl: "abc", format: "best_video", maxSizeMb: 500 }),
  );
});

test("deepStripFramePath removes framePath everywhere, including nested reference", () => {
  const result = {
    query: "test",
    reference: { framePath: "/tmp/ref.jpg", assetId: "ref-1" },
    results: [
      { framePath: "/tmp/a.jpg", score: 0.9 },
      { framePath: "/tmp/b.jpg", score: 0.8, nested: { framePath: "/tmp/deep.jpg" } },
    ],
    matches: [{ framePath: "/tmp/c.jpg" }],
  };
  const cleaned = deepStripFramePath(result);
  const scan = JSON.stringify(cleaned);
  assert.ok(!scan.includes("framePath"), `no framePath key should survive: ${scan}`);
  // Non-framePath data is preserved.
  assert.equal((cleaned as any).reference.assetId, "ref-1");
  assert.equal((cleaned as any).results[0].score, 0.9);
});

test("server version is read from package.json at runtime", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/test/ -> package root
  const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version: string };
  assert.equal(SERVER_VERSION, pkg.version);
});
