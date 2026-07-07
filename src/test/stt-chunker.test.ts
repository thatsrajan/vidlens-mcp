import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chunkAudioForStt, cleanupChunks, deriveChunkDurationSec, type AudioChunk } from "../lib/stt/chunker.js";

test("deriveChunkDurationSec keeps each chunk under the byte cap", () => {
  // 26 MB over 240 s ≈ 113.8 KB/s; a 20 MB cap must yield chunks shorter than the file.
  const sizeBytes = 26 * 1024 * 1024;
  const durationSec = 240;
  const maxBytes = 20 * 1024 * 1024;
  const chunkSec = deriveChunkDurationSec(sizeBytes, durationSec, maxBytes);

  assert.ok(chunkSec > 0);
  assert.ok(chunkSec < durationSec, "a large file must be split into shorter chunks");
  const bytesPerSec = sizeBytes / durationSec;
  assert.ok(chunkSec * bytesPerSec <= maxBytes, "projected chunk size must stay under the cap");
});

test("deriveChunkDurationSec scales inversely with bitrate", () => {
  const maxBytes = 10 * 1024 * 1024;
  const lowBitrate = deriveChunkDurationSec(10 * 1024 * 1024, 600, maxBytes); // ~17 KB/s
  const highBitrate = deriveChunkDurationSec(100 * 1024 * 1024, 600, maxBytes); // ~170 KB/s
  assert.ok(lowBitrate > highBitrate, "higher bitrate must produce shorter chunks");
});

test("deriveChunkDurationSec never exceeds an explicit cap", () => {
  // Low bitrate would otherwise allow a very long chunk; the explicit cap wins.
  const derived = deriveChunkDurationSec(1 * 1024 * 1024, 3600, 20 * 1024 * 1024, 120);
  assert.equal(derived, 120);
});

test("deriveChunkDurationSec floors at 1 second for extreme bitrates", () => {
  const derived = deriveChunkDurationSec(1024 * 1024 * 1024, 10, 1024);
  assert.equal(derived, 1);
});

test("chunkAudioForStt returns a single passthrough chunk when under the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-chunk-small-"));
  try {
    const audio = join(dir, "small.m4a");
    writeFileSync(audio, Buffer.alloc(1024));
    const chunks = await chunkAudioForStt(audio, { maxBytes: 24 * 1024 * 1024 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.path, audio);
    assert.equal(chunks[0]!.startSec, 0);
    // A passthrough chunk must not create a temp dir to clean up.
    assert.ok(!existsSync(`${audio}.chunks`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupChunks removes generated chunk dirs but leaves the source file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-chunk-clean-"));
  try {
    const original = join(dir, "audio.m4a");
    writeFileSync(original, Buffer.alloc(16));
    const chunkDir = `${original}.chunks`;
    mkdirSync(chunkDir, { recursive: true });
    const chunkA = join(chunkDir, "audio-chunk-001.m4a");
    const chunkB = join(chunkDir, "audio-chunk-002.m4a");
    writeFileSync(chunkA, Buffer.alloc(8));
    writeFileSync(chunkB, Buffer.alloc(8));

    const chunks: AudioChunk[] = [
      { path: chunkA, startSec: 0 },
      { path: chunkB, startSec: 100 },
    ];
    cleanupChunks(chunks, original);

    assert.ok(!existsSync(chunkDir), "generated chunk dir should be removed");
    assert.ok(existsSync(original), "source file must be preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupChunks is a no-op for passthrough chunks", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-chunk-pass-"));
  try {
    const original = join(dir, "audio.m4a");
    writeFileSync(original, Buffer.alloc(16));
    cleanupChunks([{ path: original, startSec: 0 }], original);
    assert.ok(existsSync(original), "passthrough source must not be deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Integration: a real high-bitrate WAV over a small cap must split into multiple
// chunks that each stay under the cap, and cleanup must remove the temp dir. Skips
// unless ffmpeg + ffprobe are present so CI without them stays green.
const canRunFfmpeg = onPath("ffmpeg") && onPath("ffprobe");

test("chunkAudioForStt splits a large file into sub-cap chunks", { skip: !canRunFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-chunk-int-"));
  try {
    const audio = join(dir, "tone.wav");
    // 8 s of 44.1 kHz stereo 16-bit ≈ 1.4 MB.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-ar", "44100", "-ac", "2", audio]);
    const maxBytes = 300 * 1024;
    const chunks = await chunkAudioForStt(audio, { maxBytes });
    try {
      assert.ok(chunks.length > 1, "a file above the cap must be chunked");
      for (const chunk of chunks) {
        assert.notEqual(chunk.path, audio, "chunk should be a generated file, not the source");
        assert.ok(statSync(chunk.path).size <= maxBytes, `chunk ${chunk.path} must stay under the cap`);
      }
    } finally {
      cleanupChunks(chunks, audio);
    }
    assert.ok(!existsSync(`${audio}.chunks`), "temp chunk dir must be cleaned up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function onPath(binary: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [binary], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
