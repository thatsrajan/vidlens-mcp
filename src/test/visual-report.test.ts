import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateVisualReport } from "../lib/visual-report.js";

test("visual report frame links use Instagram source URLs instead of YouTube fallbacks", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "vidlens-visual-report-"));
  const instagramUrl = "https://www.instagram.com/reel/C0DEVIDLENS/";

  const report = generateVisualReport({
    query: "instagram frame",
    outputDir,
    frames: [{
      framePath: join(outputDir, "missing.jpg"),
      videoId: "instagram_c0devidlens",
      videoTitle: "Instagram Reel",
      timestampSec: 42,
      timestampLabel: "0:42",
      sourceVideoUrl: instagramUrl,
    }],
  });

  assert.ok(report.html.includes(`href="${instagramUrl}"`));
  assert.equal(report.html.includes("https://youtu.be/instagram_c0devidlens"), false);
});

test("visual report preserves timestamped YouTube links for YouTube sources", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "vidlens-visual-report-"));

  const report = generateVisualReport({
    query: "youtube frame",
    outputDir,
    frames: [{
      framePath: join(outputDir, "missing.jpg"),
      videoId: "video1234567",
      timestampSec: 42,
      sourceVideoUrl: "https://www.youtube.com/watch?v=video1234567",
    }],
  });

  assert.ok(report.html.includes("https://www.youtube.com/watch?v=video1234567&amp;t=42"));
});

test("visual report drops non-http(s) source URLs instead of putting them in an href", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "vidlens-visual-report-"));

  const report = generateVisualReport({
    query: "javascript scheme",
    outputDir,
    frames: [{
      framePath: join(outputDir, "missing.jpg"),
      videoId: "video1234567",
      timestampSec: 10,
      // Attacker-controlled scheme that must never reach an <a href>.
      sourceVideoUrl: "javascript:alert(document.domain)",
    }],
  });

  assert.equal(report.html.includes("javascript:"), false);
  assert.equal(report.html.includes("alert(document.domain)"), false);
  // No YouTube fallback either — the link is dropped, timestamp renders as an inert span.
  assert.equal(report.html.includes("https://youtu.be/video1234567"), false);
  assert.ok(report.html.includes('<span class="timestamp">'));
});

test("visual report keeps a safe timestamped YouTube link but never a data: URL", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "vidlens-visual-report-"));

  const report = generateVisualReport({
    query: "data scheme",
    outputDir,
    frames: [{
      framePath: join(outputDir, "missing.jpg"),
      videoId: "video1234567",
      timestampSec: 3,
      sourceVideoUrl: "data:text/html,<script>alert(1)</script>",
    }],
  });

  assert.equal(report.html.includes("data:text/html"), false);
  assert.equal(report.html.includes("<script>alert(1)"), false);
});
