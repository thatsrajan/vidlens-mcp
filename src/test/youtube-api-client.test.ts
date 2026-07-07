import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { YouTubeApiClient } from "../lib/youtube-api-client.js";

/** Builds a minimal Response-like object for the mocked fetch. */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Recorded {
  path: string;
  params: URLSearchParams;
}

/**
 * Installs a mocked global fetch that answers YouTube Data API list endpoints
 * from an in-memory pool, honoring `maxResults`/`pageToken` so pagination is
 * exercised for real. Returns the recorded requests.
 */
function mockYouTubeApi(pool: {
  comments?: number;
  playlistItems?: number;
}): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname.split("/").pop() ?? "";
    const params = url.searchParams;
    calls.push({ path, params });

    const max = Number(params.get("maxResults") ?? "0");
    const start = Number(params.get("pageToken") ?? "0");

    if (path === "commentThreads") {
      const total = pool.comments ?? 0;
      const end = Math.min(start + max, total);
      const items = [];
      for (let i = start; i < end; i++) {
        items.push({
          id: `c${i}`,
          snippet: { topLevelComment: { snippet: { textDisplay: `comment ${i}` } } },
        });
      }
      return jsonResponse({
        items,
        nextPageToken: end < total ? String(end) : undefined,
      });
    }

    if (path === "playlistItems") {
      const total = pool.playlistItems ?? 0;
      const end = Math.min(start + max, total);
      const items = [];
      for (let i = start; i < end; i++) {
        items.push({ snippet: { resourceId: { videoId: `v${i}` } } });
      }
      return jsonResponse({
        items,
        nextPageToken: end < total ? String(end) : undefined,
      });
    }

    if (path === "videos") {
      const ids = (params.get("id") ?? "").split(",").filter(Boolean);
      return jsonResponse({
        items: ids.map((id) => ({
          id,
          snippet: { title: `Video ${id}` },
          contentDetails: { duration: "PT1M" },
          statistics: {},
        })),
      });
    }

    throw new Error(`unexpected endpoint: ${path}`);
  });
  return { calls };
}

afterEach(() => {
  mock.restoreAll();
});

describe("YouTubeApiClient pagination (WS4-5)", () => {
  it("pages commentThreads past the 100-item cap up to the requested count", async () => {
    const { calls } = mockYouTubeApi({ comments: 500 });
    const client = new YouTubeApiClient({ apiKey: "test" });

    const comments = await client.getVideoComments("vid", 150);

    assert.equal(comments.length, 150);
    const commentCalls = calls.filter((c) => c.path === "commentThreads");
    // 100 then 50 → two requests, the second carrying a pageToken.
    assert.equal(commentCalls.length, 2);
    assert.equal(commentCalls[0].params.get("maxResults"), "100");
    assert.equal(commentCalls[1].params.get("maxResults"), "50");
    assert.equal(commentCalls[1].params.get("pageToken"), "100");
  });

  it("stops paginating comments when the pool is exhausted early", async () => {
    mockYouTubeApi({ comments: 30 });
    const client = new YouTubeApiClient({ apiKey: "test" });

    const comments = await client.getVideoComments("vid", 200);

    assert.equal(comments.length, 30);
  });

  it("pages playlistItems past the 50-item cap and batches the videos lookup", async () => {
    const { calls } = mockYouTubeApi({ playlistItems: 500 });
    const client = new YouTubeApiClient({ apiKey: "test" });

    const videos = await client.getPlaylistVideos("PL123", 150);

    assert.equal(videos.length, 150);
    const itemCalls = calls.filter((c) => c.path === "playlistItems");
    // 50 * 3 pages.
    assert.equal(itemCalls.length, 3);
    assert.equal(itemCalls[2].params.get("pageToken"), "100");
    // videos endpoint batches ids at 50 → 3 calls, none exceeding the cap.
    const videoCalls = calls.filter((c) => c.path === "videos");
    assert.equal(videoCalls.length, 3);
    for (const call of videoCalls) {
      assert.ok((call.params.get("id") ?? "").split(",").length <= 50);
    }
  });
});
