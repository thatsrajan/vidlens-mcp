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
import { ScrapeCreatorsClient, sortSocialTrendResults } from "../lib/scrapecreators-client.js";
import { offsetTranscript, stitchTranscripts } from "../lib/stt/chunker.js";
import { OpenAiWhisperProvider } from "../lib/stt/openai-whisper-provider.js";
import { selectSttProvider } from "../lib/stt/selector.js";
import { upsertCodexConfig } from "../lib/cli-runtime.js";
import { TranscriptKnowledgeBase } from "../lib/knowledge-base.js";
import { resolveVideoSource } from "../lib/video-source.js";
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

test("ScrapeCreators client normalizes TikTok and Instagram search results", async () => {
  const calls: string[] = [];
  const client = new ScrapeCreatorsClient("sc-test", (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/tiktok/search/top")) {
      return new Response(JSON.stringify({
        items: [{
          id: "7620673421353012494",
          desc: "Agent coding workflow",
          create_time: "2026-03-24T04:25:45.000Z",
          author: { unique_id: "sampledev", nickname: "Sample Dev" },
          statistics: { play_count: 1000, digg_count: 100, comment_count: 10, share_count: 5 },
          video: { duration: 42, cover: { url_list: ["https://example.com/cover.jpg"] } },
          url: "https://www.tiktok.com/@sampledev/video/7620673421353012494",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      reels: [{
        shortcode: "DOq6eV6iIgD",
        url: "https://www.instagram.com/reel/DOq6eV6iIgD/",
        caption: "Agent workflow reel",
        user: { username: "sampledev" },
        like_count: 50,
        comment_count: 4,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const result = await client.search({
    query: "agent coding",
    platforms: ["tiktok", "instagram"],
    maxResults: 5,
    freshness: "month",
    sort: "engagement",
  });

  assert.equal(calls.length, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.platform, "tiktok");
  assert.equal(result.results[0]?.importableVideoSource, true);
  assert.equal(result.results[1]?.url, "https://www.instagram.com/reel/DOq6eV6iIgD/");
});

test("ScrapeCreators resolves an X status to the highest-bitrate public MP4 without returning raw payloads", async () => {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const client = new ScrapeCreatorsClient("sc-test", (async (input, init) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({
      success: true,
      credits_remaining: 99,
      legacy: {
        extended_entities: {
          media: [{
            type: "video",
            video_info: {
              variants: [
                { content_type: "application/x-mpegURL", bitrate: 2_000_000, url: "https://video.twimg.com/clip/master.m3u8" },
                { content_type: "video/mp4", bitrate: 256_000, url: "https://video.twimg.com/clip/low.mp4" },
                { content_type: "video/mp4", bitrate: "832000", url: "https://video.twimg.com/clip/high.mp4?tag=12" },
                { content_type: "video/mp4", bitrate: 9_000_000, url: "http://169.254.169.254/private.mp4" },
              ],
            },
          }],
        },
      },
      quoted_status_result: {
        result: {
          legacy: {
            extended_entities: {
              media: [{
                video_info: {
                  variants: [
                    { content_type: "video/mp4", bitrate: 8_000_000, url: "https://video.twimg.com/quoted/not-the-primary.mp4" },
                  ],
                },
              }],
            },
          },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const result = await client.resolveXMedia("https://x.com/OpenAI/status/2074907025537224840");

  assert.deepEqual(result, {
    url: "https://video.twimg.com/clip/high.mp4?tag=12",
    bitrate: 832_000,
    contentType: "video/mp4",
  });
  assert.equal(Object.keys(result).includes("raw"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.pathname, "/v1/twitter/tweet");
  assert.equal(calls[0]?.url.searchParams.get("trim"), "false");
  assert.equal(calls[0]?.url.searchParams.get("url"), "https://x.com/OpenAI/status/2074907025537224840");
  assert.equal(calls[0]?.headers.get("x-api-key"), "sc-test");
});

test("downloadAsset retries failed X audio through resolved media and preserves X identity", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-x-media-recovery-"));
  const xUrl = "https://x.com/OpenAI/status/2074907025537224840/video/1";
  const source = resolveVideoSource(xUrl);
  const downloadCalls: Array<Record<string, unknown>> = [];
  let scrapeCalls = 0;
  const service = new YouTubeService({
    dataDir,
    scrapeCreatorsApiKey: "sc-test",
    scrapeCreatorsFetch: (async () => {
      scrapeCalls += 1;
      return new Response(JSON.stringify({
        legacy: {
          extended_entities: {
            media: [{
              video_info: {
                variants: [
                  { content_type: "video/mp4", bitrate: 832_000, url: "https://video.twimg.com/clip/high.mp4?token=signed" },
                ],
              },
            }],
          },
        },
      }), { status: 200 });
    }) as typeof fetch,
  });
  (service as any)._mediaDownloader = {
    download: async (options: Record<string, unknown>) => {
      downloadCalls.push(options);
      if (downloadCalls.length === 1) throw new Error(`yt-dlp download failed for ${source.assetKey}: twitter extractor unavailable`);
      return {
        asset: {
          assetId: "asset-x-audio",
          videoId: source.assetKey,
          sourcePlatform: source.platform,
          sourceUrl: source.sourceUrl,
          sourceId: source.sourceId,
          canonicalUrl: source.canonicalUrl,
          kind: "audio",
          filePath: join(dataDir, "x-audio.m4a"),
          fileName: "x-audio.m4a",
          fileSizeBytes: 42,
          mimeType: "audio/mp4",
          createdAt: new Date(0).toISOString(),
        },
        downloadedBytes: 42,
        durationMs: 5,
        cached: false,
      };
    },
  };

  const output = await service.downloadAsset({ videoIdOrUrl: xUrl, format: "best_audio" });

  assert.equal(downloadCalls.length, 2);
  assert.equal(downloadCalls[0]?.resolvedMediaUrl, undefined);
  assert.equal(downloadCalls[1]?.resolvedMediaUrl, "https://video.twimg.com/clip/high.mp4?token=signed");
  assert.equal(scrapeCalls, 1);
  assert.equal(output.asset.videoId, source.assetKey);
  assert.equal(output.asset.sourcePlatform, "x");
  assert.equal(output.asset.sourceId, source.sourceId);
  assert.equal(output.asset.canonicalUrl, source.canonicalUrl);
  assert.equal(output.provenance.sourceTier, "scrapecreators");
  assert.equal(JSON.stringify(output).includes("token=signed"), false);
});

test("downloadAsset does not invoke ScrapeCreators recovery outside X best-audio failures", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-x-media-narrow-"));
  let scrapeCalls = 0;
  const service = new YouTubeService({
    dataDir,
    scrapeCreatorsApiKey: "sc-test",
    scrapeCreatorsFetch: (async () => {
      scrapeCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  (service as any)._mediaDownloader = {
    download: async () => { throw new Error("download failed"); },
  };

  await assert.rejects(
    () => service.downloadAsset({
      videoIdOrUrl: "https://www.tiktok.com/@vidlens/video/7350000000000000000",
      format: "best_audio",
    }),
    /download failed/,
  );
  await assert.rejects(
    () => service.downloadAsset({
      videoIdOrUrl: "https://x.com/OpenAI/status/2074907025537224840",
      format: "best_video",
    }),
    /download failed/,
  );
  await assert.rejects(
    () => service.downloadAsset({
      videoIdOrUrl: "https://x.com/OpenAI/status/2074907025537224840",
      format: "best_audio",
      maxSizeMb: Number.NaN,
    }),
    /download failed/,
  );
  assert.equal(scrapeCalls, 0);
});

test("ScrapeCreators X handle lookup requests the normalizable response and discloses popular-sample limits", async () => {
  const calls: URL[] = [];
  const client = new ScrapeCreatorsClient("sc-test", (async (input) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify({
      tweets: [
        {
          rest_id: "200",
          core: { user_results: { result: { legacy: { screen_name: "rileybrown", name: "Riley Brown" } } } },
          legacy: { full_text: "Newest sampled post", created_at: "2026-08-10T00:00:00.000Z", favorite_count: 10 },
        },
        {
          rest_id: "100",
          url: "https://x.com/rileybrown/status/100",
          legacy: { full_text: "Trimmed-shape fallback", created_at: "2026-08-09T00:00:00.000Z", favorite_count: 5 },
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const result = await client.search({
    query: "@rileybrown",
    platforms: ["x"],
    maxResults: 10,
    sort: "recent",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.pathname, "/v1/twitter/user-tweets");
  assert.equal(calls[0]?.searchParams.get("handle"), "rileybrown");
  assert.equal(calls[0]?.searchParams.get("trim"), "false");
  assert.deepEqual(result.results.map((item) => item.url), [
    "https://x.com/rileybrown/status/200",
    "https://x.com/rileybrown/status/100",
  ]);
  assert.equal(result.searched[0]?.status, "ok");
  assert.match(result.searched[0]?.detail ?? "", /not a chronological latest-tweets feed/i);
  assert.match(result.limitations.join(" "), /popular tweets, not a chronological latest-tweets feed/i);
  assert.match(result.limitations.join(" "), /verify the actual latest post/i);
});

test("social trend sorting honors recent, engagement, and relevance modes", () => {
  const input = [
    { platform: "x" as const, sourceId: "popular", url: "https://x.com/user/status/popular", publishedAt: "2026-08-01T00:00:00.000Z", score: 500, importableVideoSource: false, matchReason: "fixture" },
    { platform: "x" as const, sourceId: "newest", url: "https://x.com/user/status/newest", publishedAt: "2026-08-10T00:00:00.000Z", score: 10, importableVideoSource: false, matchReason: "fixture" },
    { platform: "x" as const, sourceId: "undated", url: "https://x.com/user/status/undated", score: 1000, importableVideoSource: false, matchReason: "fixture" },
  ];

  assert.deepEqual(sortSocialTrendResults(input, "recent").map((item) => item.sourceId), ["newest", "popular", "undated"]);
  assert.deepEqual(sortSocialTrendResults(input, "engagement").map((item) => item.sourceId), ["undated", "popular", "newest"]);
  assert.deepEqual(sortSocialTrendResults(input, "relevance").map((item) => item.sourceId), ["popular", "newest", "undated"]);
  assert.deepEqual(input.map((item) => item.sourceId), ["popular", "newest", "undated"], "sorting must not mutate provider order");
});

test("searchSocialTrends dry-run returns playlist-like social results", async () => {
  const service = new YouTubeService({ scrapeCreatorsApiKey: "sc-test" });
  const output = await service.searchSocialTrends({
    query: "agent coding",
    platforms: ["tiktok", "instagram", "reddit"],
    maxResults: 3,
  }, { dryRun: true });
  assert.equal(output.results.length, 3);
  assert.equal(output.playlist.itemCount, 3);
  assert.ok(output.playlist.importableUrls.some((url) => url.includes("tiktok.com")));
  assert.equal(output.provenance.sourceTier, "scrapecreators");
});

test("checkSystemHealth distinguishes ScrapeCreators X profile lookup from web fallback", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-health-x-discovery-"));
  const service = new YouTubeService({ dryRun: true, dataDir, scrapeCreatorsApiKey: "sc-test" });

  const output = await service.checkSystemHealth();

  assert.equal(output.keys.scrapeCreatorsConfigured, true);
  assert.deepEqual(output.xDiscovery.scrapeCreators, {
    configured: true,
    available: true,
    capability: "handle_profile_lookup",
    generalKeywordSearch: false,
    liveProbe: "not_run",
    detail: "Dry-run reports configuration only; no ScrapeCreators API request was made.",
  });
  assert.equal(output.xDiscovery.webFallback.available, true);
  assert.equal(output.xDiscovery.webFallback.capability, "keyword_and_creator_discovery");
});

test("live system health reports ScrapeCreators credential presence without spending a profile request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vidlens-health-scrapecreators-"));
  const service = new YouTubeService({
    dataDir,
    scrapeCreatorsApiKey: "sc-test",
    ytDlpBinary: join(dataDir, "missing-yt-dlp"),
  });

  const output = await service.checkSystemHealth({ runLiveChecks: false });
  const scrapeCreatorsCheck = output.checks.find((check) => check.name === "scrapecreators");
  const xPlatform = output.platforms?.find((platform) => platform.platform === "x");

  assert.equal(scrapeCreatorsCheck?.status, "ok");
  assert.match(scrapeCreatorsCheck?.detail ?? "", /no live probe was run/i);
  assert.equal(output.xDiscovery.scrapeCreators.liveProbe, "not_run");
  assert.match(xPlatform?.detail ?? "", /handle\/profile lookup: configured/i);
  assert.match(xPlatform?.detail ?? "", /general keyword search via ScrapeCreators: unsupported/i);
  assert.match(xPlatform?.detail ?? "", /web fallback:/i);
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
    existingText: [
      "[profile]",
      'model = "gpt-5"',
      "",
      "[marketplaces.vidlens]",
      'source_type = "local"',
      'source = "/repo/plugins/vidlens"',
      "",
      '[plugins."vidlens@vidlens"]',
      "enabled = true",
      "",
    ].join("\n"),
    entry: { command: "npx", args: ["-y", "vidlens-mcp", "serve"], env: { VIDLENS_DATA_DIR: "/tmp/vidlens", SCRAPECREATORS_API_KEY: "sc-test" } },
    marketplacePath: "/repo",
    printOnly: true,
  });
  assert.match(result.configText, /\[profile\]/);
  assert.match(result.configText, /\[mcp_servers\.vidlens-mcp\]/);
  assert.match(result.configText, /\[marketplaces\.vidlens-local\]/);
  assert.match(result.configText, /source = "\/repo"/);
  assert.match(result.configText, /\[plugins\."vidlens@vidlens-local"\]/);
  assert.doesNotMatch(result.configText, /\[marketplaces\.vidlens\]/);
  assert.doesNotMatch(result.configText, /\[plugins\."vidlens@vidlens"\]/);
  assert.match(result.configText, /VIDLENS_DATA_DIR = "\/tmp\/vidlens"/);
  assert.match(result.configText, /SCRAPECREATORS_API_KEY = "sc-test"/);
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

  const readByUrl = await service.readTranscript({
    videoIdOrUrl: "https://www.tiktok.com/@vidlens/video/7350000000000000000",
    mode: "full",
  });
  assert.equal(readByUrl.videoId, "tiktok_7350000000000000000");
  assert.match(readByUrl.transcript.text ?? "", /titles/i);

  const readByAssetKey = await service.readTranscript({
    videoIdOrUrl: "tiktok_7350000000000000000",
    mode: "summary",
  });
  assert.equal(readByAssetKey.videoId, "tiktok_7350000000000000000");
});
