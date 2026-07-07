import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseWhisperJson, parseWhisperJsonFile } from "../lib/stt/whisper-cpp-provider.js";

// A minimal slice of real whisper.cpp `-oj` output. Timestamps use SRT-style comma
// milliseconds ("00:00:11,000"), which is exactly the format the parser must handle.
const WHISPER_JSON = JSON.stringify({
  result: { language: "en" },
  transcription: [
    { timestamps: { from: "00:00:00,000", to: "00:00:11,000" }, text: " Hello there," },
    { timestamps: { from: "00:00:11,000", to: "00:01:02,500" }, text: " general." },
    { timestamps: { from: "00:01:02,500", to: "00:01:30,000" }, text: "   " },
  ],
});

test("parseWhisperJson decodes comma-millisecond timestamps to seconds", () => {
  const record = parseWhisperJson(WHISPER_JSON, "vid123", "en");
  assert.equal(record.videoId, "vid123");
  assert.equal(record.languageUsed, "en");
  assert.equal(record.sourceType, "generated_from_audio");
  // Blank segment is dropped; two real segments remain.
  assert.equal(record.segments.length, 2);
  assert.equal(record.segments[0]!.tStartSec, 0);
  // "00:00:11,000" -> 11s, not NaN and not the array index (1).
  assert.equal(record.segments[1]!.tStartSec, 11);
  assert.equal(record.segments[0]!.tEndSec, 11);
  // "00:01:02,500" -> 62.5s end on the second segment.
  assert.equal(record.segments[1]!.tEndSec, 62.5);
  assert.equal(record.transcriptText, "Hello there, general.");
});

test("parseWhisperJson yields monotonically increasing, non-index timestamps", () => {
  const record = parseWhisperJson(WHISPER_JSON, "vid", undefined);
  for (let i = 1; i < record.segments.length; i += 1) {
    assert.ok(
      record.segments[i]!.tStartSec >= record.segments[i - 1]!.tStartSec,
      "timestamps must be non-decreasing",
    );
  }
  // Regression guard: the buggy parser fell back to the array index (0, 1, ...).
  assert.notEqual(record.segments[1]!.tStartSec, 1);
});

test("parseWhisperJson tolerates empty/garbage input", () => {
  const record = parseWhisperJson("", "vid");
  assert.equal(record.segments.length, 0);
  assert.equal(record.transcriptText, "");
});

test("parseWhisperJsonFile reads the JSON sidecar written by -oj", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-whisper-test-"));
  try {
    const sidecar = join(dir, "clip.json");
    writeFileSync(sidecar, WHISPER_JSON);
    const record = parseWhisperJsonFile(sidecar, "vidFile", "en");
    assert.equal(record.segments.length, 2);
    assert.equal(record.segments[1]!.tStartSec, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Integration: exercises the real whisper-cli binary end-to-end, asserting the JSON
// sidecar contract this provider relies on. Skips unless both the binary and a model
// (VIDLENS_WHISPER_MODEL_PATH) are available, so CI without whisper stays green.
const whisperCli = onPath("whisper-cli");
const modelPath = process.env.VIDLENS_WHISPER_MODEL_PATH;
const canRunWhisper = Boolean(whisperCli && modelPath && existsSync(modelPath) && onPath("ffmpeg"));

test("whisper-cli writes a JSON sidecar with comma timestamps", { skip: !canRunWhisper }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-whisper-int-"));
  try {
    // Generate a short spoken-tone WAV so whisper has something to decode.
    const wav = join(dir, "clip.wav");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-ar", "16000", "-ac", "1", wav]);
    const base = join(dir, "out");
    execFileSync(whisperCli!, ["-m", modelPath!, "-f", wav, "-oj", "-of", base, "-np"]);
    const sidecar = `${base}.json`;
    assert.ok(existsSync(sidecar), "whisper-cli should write <base>.json");
    const record = parseWhisperJsonFile(sidecar, "int");
    assert.equal(record.sourceType, "generated_from_audio");
    for (const segment of record.segments) {
      assert.ok(Number.isFinite(segment.tStartSec), "every segment start must be a finite number");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function onPath(binary: string): string | undefined {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [binary]).toString().trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}
