import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiWhisperProvider } from "../lib/stt/openai-whisper-provider.js";

function withTempAudio<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-openai-stt-"));
  const audio = join(dir, "clip.m4a");
  // Small enough to be a single passthrough chunk (no ffmpeg needed).
  writeFileSync(audio, Buffer.alloc(1024));
  return run(audio).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("OpenAI provider retries a 429 then completes", async () => {
  await withTempAudio(async (audio) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAiWhisperProvider("sk-test", "gpt-4o-transcribe", fetchImpl);
    const result = await provider.transcribe(audio, { videoId: "vid" });
    assert.equal(calls, 2, "should retry once after the 429");
    assert.equal(result.transcript.transcriptText, "hello world");
  });
});

test("OpenAI provider surfaces a non-retryable error without looping", async () => {
  await withTempAudio(async (audio) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;

    const provider = new OpenAiWhisperProvider("sk-test", "gpt-4o-transcribe", fetchImpl);
    await assert.rejects(() => provider.transcribe(audio, { videoId: "vid" }), /HTTP 400/);
    assert.equal(calls, 1, "a 400 must not be retried");
  });
});

test("OpenAI provider requests verbose_json for whisper-1 and maps segments", async () => {
  await withTempAudio(async (audio) => {
    let seenFormat: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      seenFormat = body.get("response_format");
      return new Response(JSON.stringify({
        text: "one two",
        language: "en",
        segments: [
          { start: 0, end: 2.5, text: "one" },
          { start: 2.5, end: 4, text: "two" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const provider = new OpenAiWhisperProvider("sk-test", "whisper-1", fetchImpl);
    const result = await provider.transcribe(audio, { videoId: "vid" });
    assert.equal(seenFormat, "verbose_json");
    assert.equal(result.transcript.segments.length, 2);
    assert.equal(result.transcript.segments[1]!.tStartSec, 2.5, "sub-chunk timestamps must survive");
  });
});

test("OpenAI provider requests json (not verbose_json) for gpt-4o-transcribe", async () => {
  await withTempAudio(async (audio) => {
    let seenFormat: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      seenFormat = body.get("response_format");
      return new Response(JSON.stringify({ text: "spoken words" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAiWhisperProvider("sk-test", "gpt-4o-transcribe", fetchImpl);
    const result = await provider.transcribe(audio, { videoId: "vid" });
    assert.equal(seenFormat, "json");
    // No segments returned -> falls back to a single whole-transcript segment.
    assert.equal(result.transcript.segments.length, 1);
    assert.equal(result.transcript.segments[0]!.tStartSec, 0);
  });
});
