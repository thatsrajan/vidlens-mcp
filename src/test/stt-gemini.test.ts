import assert from "node:assert/strict";
import test from "node:test";
import { mimeTypeFor } from "../lib/stt/gemini-stt-provider.js";

test("Gemini STT treats downloader MP4 assets as audio", () => {
  assert.equal(mimeTypeFor("social.best_audio.mp4"), "audio/mp4");
  assert.equal(mimeTypeFor("clip.m4a"), "audio/mp4");
  assert.equal(mimeTypeFor("clip.wav"), "audio/wav");
});
