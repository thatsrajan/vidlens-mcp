import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CookieStore } from "../lib/auth/cookie-store.js";
import { denoDownloadUrl } from "../lib/diagnostics/deno-installer.js";
import { assessYtDlpFreshness } from "../lib/diagnostics/yt-dlp-freshness.js";
import { allProviders } from "../lib/providers/registry.js";
import { redactError, redactSecrets } from "../lib/redactor.js";
import { offsetTranscript, stitchTranscripts } from "../lib/stt/chunker.js";
import { OpenAiWhisperProvider } from "../lib/stt/openai-whisper-provider.js";
import { selectSttProvider } from "../lib/stt/selector.js";
import { upsertCodexConfig } from "../lib/cli-runtime.js";
import { TranscriptKnowledgeBase } from "../lib/knowledge-base.js";
import { YouTubeService } from "../lib/youtube-service.js";
import { parseDuckDuckGoHtml } from "../lib/web-search/duckduckgo-lite-provider.js";
import { selectWebSearchProvider } from "../lib/web-search/selector.js";

test("cookie store resolves platform files before browser cookies and reports unreadable paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidlens-cookie-"));
  const cookiePath = join(dir, "x-cookies.txt");
  writeFileSync(cookiePath, "# Netscape cookies\n", "utf8");

  const withFile = new CookieStore({
    VIDLENS_X_COOKIES_FILE: cookiePath,
    VIDLENS_COOKIES_FROM_BROWSER: "chrome",
  });
  assert.deepEqual(withFile.argsFor("x"), ["--cookies", cookiePath]);

  const unreadable = new CookieStore({ VIDLENS_X_COOKIES_FILE: join(dir, "missing.txt") }).resolve("x");
  assert.equal(unreadable.mode, "none");
  assert.match(unreadable.warning ?? "", /not readable/);

  const browser = new CookieStore({ VIDLENS_COOKIES_FROM_BROWSER: "chrome", VIDLENS_COOKIES_PROFILE: "Default" });
  assert.deepEqual(browser.argsFor("instagram"), ["--cookies-from-browser", "chrome:Default"]);
});

test("redactor removes env secrets and cookie-shaped values from public strings", () => {
  const secret = "sk-test-secret-value";
  const redacted = redactSecrets(`Authorization: Bearer ${secret}\nCookie: sessionid=abc123\nvalue=${secret}`, {
    OPENAI_API_KEY: secret,
  });
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\[redacted\]/);
  assert.equal(redactError(new Error(`failed with ${secret}`), { OPENAI_API_KEY: secret }).includes(secret), false);
});

test("provider capabilities keep transcript boolean compatibility while exposing transcriptMode", () => {
  const ctx = {
    ytDlpBinary: "yt-dlp",
    mediaStore: {} as any,
    dataDir: "/tmp",
    cookieStore: new CookieStore({}),
    stt: { id: "openai" } as any,
    env: {},
  };
  const providers = allProviders();
  assert.equal(providers.length, 6);
  for (const provider of providers) {
    const capabilities = provider.capabilities(ctx);
    assert.equal(typeof capabilities.transcript, "boolean");
    assert.ok(["native", "stt", "unsupported"].includes(capabilities.transcriptMode ?? "unsupported"));
  }
  assert.equal(providers.find((provider) => provider.platform === "youtube")?.capabilities(ctx).transcriptMode, "native");
  assert.equal(providers.find((provider) => provider.platform === "x")?.capabilities(ctx).transcriptMode, "stt");
});

test("web search selector precedence and DuckDuckGo HTML parsing are deterministic", () => {
  assert.equal(selectWebSearchProvider({ BRAVE_API_KEY: "brave", SERPAPI_KEY: "serp" }).providerId, "brave");
  assert.equal(selectWebSearchProvider({ SERPAPI_KEY: "serp" }).providerId, "serpapi");
  assert.equal(selectWebSearchProvider({ VIDLENS_WEB_SEARCH_PROVIDER: "none" }).providerId, "none");

  const results = parseDuckDuckGoHtml(`
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fx.com%2Fuser%2Fstatus%2F123">A &amp; B</a>
  `);
  assert.equal(results[0]?.url, "https://x.com/user/status/123");
  assert.equal(results[0]?.title, "A & B");
});

test("STT selector, OpenAI provider, transcript stitching, and progress work without live network", async () => {
  assert.equal(selectSttProvider({ OPENAI_API_KEY: "key" }).providerId, "openai");
  assert.equal(selectSttProvider({ VIDLENS_STT_PROVIDER: "none", OPENAI_API_KEY: "key" }).providerId, "none");

  const dir = mkdtempSync(join(tmpdir(), "vidlens-openai-stt-"));
  const audioPath = join(dir, "clip.m4a");
  writeFileSync(audioPath, "fake audio", "utf8");
  const calls: Array<RequestInfo | URL> = [];
  const provider = new OpenAiWhisperProvider("test-key", "gpt-4o-transcribe", (async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({
      text: "hello world",
      language: "en",
      segments: [{ start: 0, end: 1.5, text: "hello world" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const progress: string[] = [];
  const result = await provider.transcribe(audioPath, {
    videoId: "clip",
    progressReporter: {
      report: (event) => {
        progress.push(`${event.current}/${event.total}`);
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.transcript.transcriptText, "hello world");
  assert.deepEqual(progress, ["0/1", "1/1"]);

  const placeholderProvider = new OpenAiWhisperProvider("test-key", "gpt-4o-transcribe", (async () =>
    new Response(JSON.stringify({ text: "TRANSCRIPTION" }), { status: 200, headers: { "content-type": "application/json" } })
  ) as typeof fetch);
  await assert.rejects(
    () => placeholderProvider.transcribe(audioPath, { videoId: "clip" }),
    /no usable transcript text/,
  );

  const offset = offsetTranscript(result.transcript, 10);
  assert.equal(offset.segments[0]?.tStartSec, 10);
  assert.equal(stitchTranscripts("clip", [result.transcript, offset]).segments[1]?.tStartSec, 10);
});

test("yt-dlp freshness buckets are deterministic", () => {
  assert.equal(assessYtDlpFreshness("2026.05.01", new Date("2026-05-09T00:00:00Z")).status, "fresh");
  assert.equal(assessYtDlpFreshness("2026.03.01", new Date("2026-05-09T00:00:00Z")).status, "stale");
  assert.equal(assessYtDlpFreshness("2025.12.01", new Date("2026-05-09T00:00:00Z")).status, "severely_stale");
});

test("Deno managed download URL resolves supported platforms", () => {
  assert.match(denoDownloadUrl("darwin", "arm64"), /deno-aarch64-apple-darwin\.zip$/);
  assert.match(denoDownloadUrl("linux", "x64"), /deno-x86_64-unknown-linux-gnu\.zip$/);
});

test("Codex setup TOML preserves unrelated blocks and writes MCP plus plugin registrations", () => {
  const result = upsertCodexConfig({
    configPath: "/tmp/config.toml",
    existingText: "[profile]\nmodel = \"gpt-5\"\n",
    entry: { command: "npx", args: ["-y", "vidlens-mcp", "serve"], env: { VIDLENS_DATA_DIR: "/tmp/vidlens" } },
    pluginPath: "/repo/plugins/vidlens",
    printOnly: true,
  });
  assert.match(result.configText, /\[profile\]/);
  assert.match(result.configText, /\[mcp_servers\.vidlens-mcp\]/);
  assert.match(result.configText, /\[marketplaces\.vidlens\]/);
  assert.match(result.configText, /\[plugins\."vidlens@vidlens"\]/);
  assert.match(result.configText, /VIDLENS_DATA_DIR = "\/tmp\/vidlens"/);
});

test("source-aware KB search does not fabricate YouTube URLs for non-YouTube transcripts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-kb-source-"));
  const kb = new TranscriptKnowledgeBase({ dataDir });
  kb.importVideos(
    { collectionId: "social", sourceType: "videos", label: "Social" },
    [{
      video: {
        videoId: "x_123",
        title: "X clip",
        channelTitle: "x",
        url: "https://x.com/user/status/123",
        transcriptAvailable: true,
        sourcePlatform: "x",
        sourceId: "123",
        canonicalUrl: "https://x.com/user/status/123",
      },
      transcript: {
        videoId: "x_123",
        sourceType: "generated_from_audio",
        transcriptText: "the benchmark chart appears here",
        segments: [{ tStartSec: 7, tEndSec: 12, text: "the benchmark chart appears here" }],
      },
      options: { strategy: "auto", chunkSizeSec: 120, chunkOverlapSec: 30 },
    }],
  );
  const search = await kb.search({ query: "benchmark chart", collectionId: "social", minScore: 0.01 });
  assert.equal(search.results[0]?.sourcePlatform, "x");
  assert.equal(search.results[0]?.canonicalUrl, "https://x.com/user/status/123");
  assert.equal(search.results[0]?.timestampUrl.includes("youtu.be"), false);
});

test("transcribeVideoSource dry-run persists a searchable non-YouTube transcript", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-service-transcribe-"));
  const service = new YouTubeService({ dataDir, ytDlpBinary: "yt-dlp" });
  const output = await service.transcribeVideoSource({
    source: "https://www.tiktok.com/@vidlens/video/7350000000000000000",
    collectionId: "tik",
  }, { dryRun: true });
  assert.equal(output.transcript.sourceType, "generated_from_audio");
  const search = await service.searchTranscripts({ query: "titles clicks", collectionId: "tik", minScore: 0.01 });
  assert.ok(search.results.length > 0);
  assert.equal(search.results[0]?.sourcePlatform, "tiktok");
  assert.equal(search.results[0]?.timestampUrl.includes("youtu.be"), false);
});
