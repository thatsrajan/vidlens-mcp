import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCommentsArgs } from "../lib/ytdlp-client.js";

// ── buildCommentsArgs ────────────────────────────────────────────────────────

describe("buildCommentsArgs", () => {
  it("enables comment extraction with --write-comments", () => {
    const args = buildCommentsArgs("https://www.youtube.com/watch?v=abc", 25);
    // WS1-2: without --write-comments yt-dlp never populates payload.comments.
    assert.ok(args.includes("--write-comments"), "must pass --write-comments");
  });

  it("caps the count via the youtube:max_comments extractor-arg", () => {
    const args = buildCommentsArgs("https://www.youtube.com/watch?v=abc", 25);
    const idx = args.indexOf("--extractor-args");
    assert.notEqual(idx, -1, "must pass --extractor-args");
    assert.equal(args[idx + 1], "youtube:max_comments=25");
  });

  it("does not use the invalid `getcomments` extractor-arg", () => {
    const args = buildCommentsArgs("https://www.youtube.com/watch?v=abc", 10);
    assert.ok(!args.some((a) => a.includes("getcomments")));
  });

  it("clamps a non-positive count up to 1", () => {
    const args = buildCommentsArgs("https://www.youtube.com/watch?v=abc", 0);
    assert.ok(args.includes("youtube:max_comments=1"));
  });

  it("puts the video URL last", () => {
    const url = "https://www.youtube.com/watch?v=abc";
    const args = buildCommentsArgs(url, 5);
    assert.equal(args[args.length - 1], url);
  });
});
