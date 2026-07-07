import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GeminiVisualDescriber } from "../lib/gemini-visual-describer.js";

function fixtureFrame(): string {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-gemini-describer-"));
  const filePath = join(dir, "frame.jpg");
  writeFileSync(filePath, "fixture");
  return filePath;
}

test("describer counts failed frames and does not report them as descriptions", async () => {
  const describer = new GeminiVisualDescriber("test-key");
  // Inject a client whose call fails with a non-retryable (fast) error.
  (describer as unknown as { client: unknown }).client = {
    models: {
      generateContent: async () => {
        throw new Error("permission denied");
      },
    },
  };

  const framePath = fixtureFrame();
  const batch = await describer.describeFrames([{ framePath, videoId: "v1", timestampSec: 5 }]);

  assert.equal(batch.failures, 1);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0]?.failed, true);
  assert.equal(batch.results[0]?.description, undefined);
});

test("describer returns descriptions with zero failures on success", async () => {
  const describer = new GeminiVisualDescriber("test-key");
  (describer as unknown as { client: unknown }).client = {
    models: {
      generateContent: async () => ({ text: "A cat on a keyboard." }),
    },
  };

  const framePath = fixtureFrame();
  const batch = await describer.describeFrames([{ framePath, videoId: "v1", timestampSec: 5 }]);

  assert.equal(batch.failures, 0);
  assert.equal(batch.results[0]?.description, "A cat on a keyboard.");
  assert.equal(batch.results[0]?.failed, undefined);
});

test("describer with no API key returns pass-through results and zero failures", async () => {
  const describer = new GeminiVisualDescriber(undefined);
  const batch = await describer.describeFrames([{ framePath: "/tmp/x.jpg", videoId: "v1", timestampSec: 0 }]);
  assert.equal(batch.failures, 0);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0]?.description, undefined);
});
