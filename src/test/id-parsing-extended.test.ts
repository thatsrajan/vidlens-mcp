import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseVideoId,
  parsePlaylistId,
  parseChannelRef,
  buildVideoUrl,
  buildPlaylistUrl,
  buildChannelUrl,
} from "../lib/id-parsing.js";

describe("parseVideoId", () => {
  it("parses a standard YouTube URL", () => {
    assert.equal(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses a short URL", () => {
    assert.equal(parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses a short URL with timestamp", () => {
    assert.equal(parseVideoId("https://youtu.be/dQw4w9WgXcQ?t=30"), "dQw4w9WgXcQ");
  });

  it("parses a URL with playlist parameter", () => {
    assert.equal(
      parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLyyy"),
      "dQw4w9WgXcQ",
    );
  });

  it("parses a bare video ID", () => {
    assert.equal(parseVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses a shorts URL", () => {
    assert.equal(parseVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses an embed URL", () => {
    assert.equal(parseVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses a live URL", () => {
    assert.equal(parseVideoId("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses a URL without www", () => {
    assert.equal(parseVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses a URL with extra query parameters", () => {
    assert.equal(
      parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be&t=120"),
      "dQw4w9WgXcQ",
    );
  });

  it("rejects empty string", () => {
    assert.equal(parseVideoId(""), null);
  });

  it("rejects whitespace-only string", () => {
    assert.equal(parseVideoId("   "), null);
  });

  it("rejects random text", () => {
    assert.equal(parseVideoId("not-a-video-id"), null);
  });

  it("rejects malformed URLs", () => {
    assert.equal(parseVideoId("https://www.google.com/search?q=youtube"), null);
  });

  it("rejects video ID that is too short", () => {
    assert.equal(parseVideoId("abc"), null);
  });

  it("rejects video ID that is too long", () => {
    assert.equal(parseVideoId("dQw4w9WgXcQextra"), null);
  });

  it("handles URL with /v/ path marker", () => {
    assert.equal(parseVideoId("https://www.youtube.com/v/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("trims whitespace from input", () => {
    assert.equal(parseVideoId("  dQw4w9WgXcQ  "), "dQw4w9WgXcQ");
  });

  it("does not fabricate an ID from a non-video channel URL path", () => {
    // Both trailing segments are 11 chars and matched the old loose fallback,
    // but neither URL is a video URL.
    assert.equal(parseVideoId("https://www.youtube.com/c/TechLinked1"), null);
    assert.equal(parseVideoId("https://www.youtube.com/user/Creator1234"), null);
  });

  it("rejects a URL whose only 11-char token is not behind a video marker", () => {
    assert.equal(parseVideoId("https://example.com/some/AbcDefGhi12"), null);
  });
});

describe("parsePlaylistId", () => {
  it("parses a bare playlist ID starting with PL", () => {
    assert.equal(parsePlaylistId("PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4"), "PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4");
  });

  it("parses a playlist URL", () => {
    assert.equal(
      parsePlaylistId("https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4"),
      "PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4",
    );
  });

  it("parses a playlist ID from a watch URL with list parameter", () => {
    assert.equal(
      parsePlaylistId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4"),
      "PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4",
    );
  });

  it("parses UU-prefixed (uploads) playlist ID", () => {
    assert.equal(parsePlaylistId("UU_x5XG1OV2P6uZZ5FSM9Ttw"), "UU_x5XG1OV2P6uZZ5FSM9Ttw");
  });

  it("parses OLAK5uy_ prefixed playlist ID", () => {
    const olakId = "OLAK5uy_abcdef1234567890";
    assert.equal(parsePlaylistId(olakId), olakId);
  });

  it("parses RD-prefixed (mix) playlist ID", () => {
    const rdId = "RDdQw4w9WgXcQ";
    assert.equal(parsePlaylistId(rdId), rdId);
  });

  it("rejects empty string", () => {
    assert.equal(parsePlaylistId(""), null);
  });

  it("rejects random text", () => {
    assert.equal(parsePlaylistId("not-a-playlist"), null);
  });

  it("rejects a bare video ID", () => {
    assert.equal(parsePlaylistId("dQw4w9WgXcQ"), null);
  });
});

describe("parseChannelRef", () => {
  it("parses a channel URL with /channel/ path", () => {
    const result = parseChannelRef("https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw");
    assert.deepEqual(result, { type: "id", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" });
  });

  it("parses a channel handle URL with @", () => {
    const result = parseChannelRef("https://www.youtube.com/@GoogleDevelopers");
    assert.deepEqual(result, { type: "handle", value: "GoogleDevelopers" });
  });

  it("parses a bare channel handle starting with @", () => {
    const result = parseChannelRef("@GoogleDevelopers");
    assert.deepEqual(result, { type: "handle", value: "GoogleDevelopers" });
  });

  it("parses a bare channel ID (UC-prefixed)", () => {
    const result = parseChannelRef("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    assert.deepEqual(result, { type: "id", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" });
  });

  it("parses a /c/ custom URL", () => {
    const result = parseChannelRef("https://www.youtube.com/c/GoogleDevelopers");
    assert.deepEqual(result, { type: "custom", value: "GoogleDevelopers" });
  });

  it("parses a /user/ URL", () => {
    const result = parseChannelRef("https://www.youtube.com/user/GoogleDevelopers");
    assert.deepEqual(result, { type: "custom", value: "GoogleDevelopers" });
  });

  it("treats plain text as custom reference", () => {
    const result = parseChannelRef("GoogleDevelopers");
    assert.deepEqual(result, { type: "custom", value: "GoogleDevelopers" });
  });

  it("returns null for empty string", () => {
    assert.equal(parseChannelRef(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.equal(parseChannelRef("   "), null);
  });

  it("returns url type for unrecognized YouTube URL patterns", () => {
    const result = parseChannelRef("https://www.youtube.com/");
    assert.ok(result, "should return a result");
    assert.equal(result.type, "url");
  });
});

describe("buildVideoUrl", () => {
  it("builds correct YouTube watch URL", () => {
    assert.equal(buildVideoUrl("dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("buildPlaylistUrl", () => {
  it("builds correct YouTube playlist URL", () => {
    assert.equal(
      buildPlaylistUrl("PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4"),
      "https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54FNRU3kVZKeTxQqM2C4",
    );
  });
});

describe("buildChannelUrl", () => {
  it("builds URL from channel ID", () => {
    assert.equal(
      buildChannelUrl({ type: "id", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" }),
      "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
    );
  });

  it("builds URL from handle", () => {
    assert.equal(
      buildChannelUrl({ type: "handle", value: "GoogleDevelopers" }),
      "https://www.youtube.com/@GoogleDevelopers",
    );
  });

  it("builds URL from custom name", () => {
    assert.equal(
      buildChannelUrl({ type: "custom", value: "GoogleDevelopers" }),
      "https://www.youtube.com/GoogleDevelopers",
    );
  });

  it("returns raw URL for url type", () => {
    assert.equal(
      buildChannelUrl({ type: "url", value: "https://www.youtube.com/some/path" }),
      "https://www.youtube.com/some/path",
    );
  });
});
