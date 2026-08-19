import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isConcreteVideoSource, resolveVideoSource } from "../lib/video-source.js";

test("resolveVideoSource keeps YouTube IDs backward compatible as asset keys", () => {
  const source = resolveVideoSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(source.platform, "youtube");
  assert.equal(source.sourceId, "dQw4w9WgXcQ");
  assert.equal(source.assetKey, "dQw4w9WgXcQ");
  assert.equal(source.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(source.capabilities.search, "native");
});

test("resolveVideoSource parses X/Twitter status URLs", () => {
  const source = resolveVideoSource("https://x.com/openai/status/1234567890?s=20");
  assert.equal(source.platform, "x");
  assert.equal(source.sourceId, "1234567890");
  assert.equal(source.assetKey, "x_1234567890");
  assert.equal(source.canonicalUrl, "https://x.com/openai/status/1234567890");
  assert.equal(source.capabilities.search, "web_fallback");
});

test("resolveVideoSource parses Instagram reels", () => {
  const source = resolveVideoSource("https://www.instagram.com/reel/C8AbCdEfGhi/?igsh=abc");
  assert.equal(source.platform, "instagram");
  assert.equal(source.sourceId, "C8AbCdEfGhi");
  assert.equal(source.assetKey, "instagram_c8abcdefghi");
});

test("resolveVideoSource parses TikTok video URLs", () => {
  const source = resolveVideoSource("https://www.tiktok.com/@creator/video/7350000000000000000?lang=en");
  assert.equal(source.platform, "tiktok");
  assert.equal(source.sourceId, "7350000000000000000");
  assert.equal(source.assetKey, "tiktok_7350000000000000000");
});

test("resolveVideoSource routes look-alike hostnames to generic_url", () => {
  assert.equal(resolveVideoSource("https://notyoutube.com/watch?v=abc").platform, "generic_url");
  assert.equal(resolveVideoSource("https://fake-tiktok.com/@x/video/123").platform, "generic_url");
  assert.equal(resolveVideoSource("https://myinstagram.com/reel/abc").platform, "generic_url");
  assert.equal(resolveVideoSource("https://nottwitter.com/x/status/1").platform, "generic_url");
});

test("resolveVideoSource still matches real platform subdomains", () => {
  assert.equal(resolveVideoSource("https://m.youtube.com/watch?v=dQw4w9WgXcQ").platform, "youtube");
  assert.equal(resolveVideoSource("https://vm.tiktok.com/ZMabc123/").platform, "tiktok");
});

test("distinguishes concrete social videos from profiles and explore pages", () => {
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://x.com/openai/status/1234567890")), true);
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://x.com/openai")), false);
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://www.instagram.com/reel/C8AbCdEfGhi/")), true);
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://www.instagram.com/openai/")), false);
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://www.instagram.com/reels/")), false);
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://www.tiktok.com/@creator/video/7350000000000000000")), true);
  assert.equal(isConcreteVideoSource(resolveVideoSource("https://www.tiktok.com/@creator")), false);
});

test("resolveVideoSource preserves query string for generic URLs", () => {
  const source = resolveVideoSource("https://videos.example.com/player?video=123&utm_source=x");
  assert.equal(source.platform, "generic_url");
  // Query identifies the video for generic URLs, so it must survive canonicalization.
  assert.ok(source.canonicalUrl.includes("video=123"), source.canonicalUrl);
});

test("resolveVideoSource strips query for known platforms", () => {
  const source = resolveVideoSource("https://www.tiktok.com/@creator/video/7350000000000000000?lang=en");
  assert.ok(!source.canonicalUrl.includes("lang=en"), source.canonicalUrl);
});

test("resolveVideoSource accepts local video files", () => {
  const dir = join(tmpdir(), `vidlens-source-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "clip.mp4");
  writeFileSync(filePath, Buffer.alloc(4));

  try {
    const source = resolveVideoSource(filePath);
    assert.equal(source.platform, "local_file");
    assert.equal(source.localPath, filePath);
    assert.equal(source.assetKey.startsWith("local_"), true);
    assert.equal(source.capabilities.search, "local_index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
