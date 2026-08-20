import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildVideoEvidenceView,
  EvidenceFrameResourceStore,
  MCP_APP_MIME_TYPE,
  VIDEO_EVIDENCE_APP_URI,
} from "../lib/mcp-app.js";
import { createYouTubeMcpServer, tools } from "../server/mcp-server.js";
import type { YouTubeService } from "../lib/youtube-service.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("video evidence tool advertises the portable MCP Apps resource and terminal fallback", () => {
  const tool = tools.find((candidate) => candidate.name === "renderVideoEvidence");
  assert.ok(tool);
  assert.equal((tool._meta as any)?.ui?.resourceUri, VIDEO_EVIDENCE_APP_URI);
  assert.equal((tool._meta as any)?.["openai/outputTemplate"], VIDEO_EVIDENCE_APP_URI);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.match(tool.description ?? "", /Codex and Claude Code terminals/i);
});

test("video evidence view never exposes local frame paths or unsafe source URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vidlens-evidence-"));
  const framePath = join(directory, "frame.png");
  await writeFile(framePath, ONE_PIXEL_PNG);
  try {
    const resources = new EvidenceFrameResourceStore();
    const view = buildVideoEvidenceView(
      {
        query: "benchmark",
        results: [
          {
            framePath,
            videoId: "abc123",
            sourceVideoTitle: "Example",
            sourceVideoUrl: "javascript:alert(1)",
            timestampSec: 12,
            timestampLabel: "0:12",
            score: 0.9,
            matchedOn: ["ocr"],
            ocrText: "benchmark",
          },
        ],
        searchMeta: { searchedFrames: 10, searchedVideos: 1, queryMode: "ocr_description_lexical" },
        limitations: ["Real mode returns actual local frame paths as evidence."],
      },
      resources,
    );

    assert.equal(view.frames[0]?.sourceVideoUrl, undefined);
    assert.match(view.frames[0]?.imageUri ?? "", /^vidlens-frame:\/\/evidence\/[a-f0-9]{24}$/);
    assert.ok(!JSON.stringify(view).includes(framePath));
    assert.ok(!JSON.stringify(view).includes("local frame paths"));
    assert.match(view.limitations[0] ?? "", /opaque MCP resources/i);
    assert.deepEqual(resources.read(view.frames[0]?.imageUri ?? "")?.blob, ONE_PIXEL_PNG.toString("base64"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP client can list and read the app, call the renderer, and fetch an opaque frame resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vidlens-mcp-app-"));
  const framePath = join(directory, "frame.png");
  await writeFile(framePath, ONE_PIXEL_PNG);

  const service = {
    searchVisualContent: async () => ({
      query: "architecture diagram",
      results: [
        {
          framePath,
          videoId: "video-1",
          sourceVideoTitle: "Architecture talk",
          sourceVideoUrl: "https://www.youtube.com/watch?v=video-1",
          timestampSec: 42,
          timestampLabel: "0:42",
          score: 0.93,
          lexicalScore: 0.8,
          semanticScore: 0.95,
          matchedOn: ["ocr", "semantic"],
          explanation: "Architecture diagram matched.",
          ocrText: "tool result -> UI resource",
          visualDescription: "A system architecture diagram.",
        },
      ],
      searchMeta: {
        searchedFrames: 12,
        searchedVideos: 1,
        descriptionProvider: "gemini",
        embeddingProvider: "gemini",
        queryMode: "gemini_semantic_plus_lexical",
      },
      limitations: [],
      provenance: { sourceTier: "none", degraded: false },
    }),
  } as unknown as YouTubeService;

  const server = createYouTubeMcpServer(service);
  const client = new Client({ name: "vidlens-test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listResources();
    const appResource = listed.resources.find((resource) => resource.uri === VIDEO_EVIDENCE_APP_URI);
    assert.equal(appResource?.mimeType, MCP_APP_MIME_TYPE);

    const appContents = await client.readResource({ uri: VIDEO_EVIDENCE_APP_URI });
    const html = appContents.contents[0];
    assert.ok(html && "text" in html);
    assert.match(html.text, /VidLens Evidence Atlas/);
    assert.match(html.text, /ui\/initialize/);
    assert.ok(!html.text.includes("/*__VIDLENS_APP_BUNDLE__*/"));
    assert.ok(!html.text.includes("__VIDLENS_BRAND_MARK__"));
    assert.match(html.text, /data:image\/png;base64,/);

    const call = await client.callTool({
      name: "renderVideoEvidence",
      arguments: { query: "architecture diagram", maxResults: 5 },
    });
    assert.equal(call.isError, undefined);
    const structured = call.structuredContent as any;
    assert.equal(structured.kind, "vidlens.video-evidence");
    assert.equal(structured.resultCount, 1);
    assert.ok(!JSON.stringify(call).includes(framePath));

    const imageUri = structured.frames[0].imageUri as string;
    const frame = await client.readResource({ uri: imageUri });
    const frameContent = frame.contents[0];
    assert.ok(frameContent && "blob" in frameContent);
    assert.equal(frameContent.mimeType, "image/png");
    assert.equal(frameContent.blob, ONE_PIXEL_PNG.toString("base64"));
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
