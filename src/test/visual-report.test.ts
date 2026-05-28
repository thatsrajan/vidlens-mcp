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
