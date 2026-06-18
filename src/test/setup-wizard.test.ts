import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { existsSync } from "node:fs";
import {
  buildServerEntry,
  inspectMcpConfigPath,
  inspectMcpConfigText,
  mergeMcpConfigText,
  parseCliArgs,
  runCli,
} from "../lib/cli-runtime.js";
import type { YouTubeService } from "../lib/youtube-service.js";

type JsonObject = Record<string, unknown>;

/**
 * Setup wizard tests covering parseCliArgs, buildServerEntry, mergeMcpConfigText,
 * inspectMcpConfigPath, and the setup command flow through runCli.
 */

describe("parseCliArgs for setup", () => {
  it("setup with no args defaults to serve command", () => {
    const parsed = parseCliArgs([]);
    assert.equal(parsed.command, "serve");
    assert.deepEqual(parsed.clientIds, []);
  });

  it("setup with --client=claude_desktop targets only Claude Desktop", () => {
    const parsed = parseCliArgs(["setup", "--client=claude_desktop"]);
    assert.equal(parsed.command, "setup");
    assert.deepEqual(parsed.clientIds, ["claude_desktop"]);
  });

  it("setup with --client=codex targets Codex CLI", () => {
    const parsed = parseCliArgs(["setup", "--client=codex"]);
    assert.equal(parsed.command, "setup");
    assert.deepEqual(parsed.clientIds, ["codex"]);
  });

  it("setup with --client=chatgpt_desktop targets ChatGPT Desktop", () => {
    const parsed = parseCliArgs(["setup", "--client=chatgpt_desktop"]);
    assert.deepEqual(parsed.clientIds, ["chatgpt_desktop"]);
  });

  it("setup with --client=ultra is alias for chatgpt_desktop", () => {
    const parsed = parseCliArgs(["setup", "--client=ultra"]);
    assert.deepEqual(parsed.clientIds, ["chatgpt_desktop"]);
  });

  it("setup with --print-only sets printOnly", () => {
    const parsed = parseCliArgs(["setup", "--print-only"]);
    assert.equal(parsed.printOnly, true);
  });

  it("setup with --advanced enables optional setup prompts", () => {
    const parsed = parseCliArgs(["setup", "--advanced"]);
    assert.equal(parsed.advancedSetup, true);
  });

  it("setup with --dry-run also sets printOnly", () => {
    const parsed = parseCliArgs(["setup", "--dry-run"]);
    assert.equal(parsed.printOnly, true);
  });

  it("setup with multiple clients", () => {
    const parsed = parseCliArgs(["setup", "--client=claude_desktop", "--client=cursor", "--client=codex"]);
    assert.deepEqual(parsed.clientIds, ["claude_desktop", "cursor", "codex"]);
  });

  it("doctor with --no-live sets noLive", () => {
    const parsed = parseCliArgs(["doctor", "--no-live"]);
    assert.equal(parsed.command, "doctor");
    assert.equal(parsed.noLive, true);
  });

  it("--help overrides command to help", () => {
    const parsed = parseCliArgs(["setup", "--help"]);
    assert.equal(parsed.command, "help");
  });

  it("rejects unknown commands", () => {
    assert.throws(() => parseCliArgs(["bogus"]));
  });

  it("rejects unknown flags", () => {
    assert.throws(() => parseCliArgs(["setup", "--unknown-flag"]));
  });

  it("parses --data-dir flag", () => {
    const parsed = parseCliArgs(["setup", "--data-dir=/custom/path"]);
    assert.equal(parsed.dataDir, "/custom/path");
  });

  it("parses --youtube-api-key flag", () => {
    const parsed = parseCliArgs(["setup", "--youtube-api-key=my-key"]);
    assert.equal(parsed.youtubeApiKey, "my-key");
  });

  it("parses --gemini-api-key flag", () => {
    const parsed = parseCliArgs(["setup", "--gemini-api-key=gem-key"]);
    assert.equal(parsed.geminiApiKey, "gem-key");
  });

  it("parses --google-api-key flag", () => {
    const parsed = parseCliArgs(["setup", "--google-api-key=goog-key"]);
    assert.equal(parsed.googleApiKey, "goog-key");
  });

  it("parses universal ingestion setup flags", () => {
    const parsed = parseCliArgs([
      "setup",
      "--openai-api-key=openai-key",
      "--scrapecreators-api-key=scrape-key",
      "--brave-api-key=brave-key",
      "--serpapi-key=serpapi-key",
      "--web-search-provider=brave",
      "--stt-provider=openai",
      "--stt-language-hint=en",
      "--whisper-model-path=/models/ggml.bin",
      "--cookies-from-browser=chrome",
      "--cookies-profile=Default",
      "--youtube-cookies-file=/cookies/youtube.txt",
      "--x-cookies-file=/cookies/x.txt",
      "--instagram-cookies-file=/cookies/instagram.txt",
      "--tiktok-cookies-file=/cookies/tiktok.txt",
    ]);

    assert.equal(parsed.openaiApiKey, "openai-key");
    assert.equal(parsed.scrapeCreatorsApiKey, "scrape-key");
    assert.equal(parsed.braveApiKey, "brave-key");
    assert.equal(parsed.serpapiKey, "serpapi-key");
    assert.equal(parsed.webSearchProvider, "brave");
    assert.equal(parsed.sttProvider, "openai");
    assert.equal(parsed.sttLanguageHint, "en");
    assert.equal(parsed.whisperModelPath, "/models/ggml.bin");
    assert.equal(parsed.cookiesFromBrowser, "chrome");
    assert.equal(parsed.cookiesProfile, "Default");
    assert.equal(parsed.youtubeCookiesFile, "/cookies/youtube.txt");
    assert.equal(parsed.xCookiesFile, "/cookies/x.txt");
    assert.equal(parsed.instagramCookiesFile, "/cookies/instagram.txt");
    assert.equal(parsed.tiktokCookiesFile, "/cookies/tiktok.txt");
  });
});

describe("buildServerEntry", () => {
  it("creates correct entry structure", () => {
    const entry = buildServerEntry({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/vidlens/dist/cli.js",
      dataDir: "/home/user/.vidlens",
    });

    assert.equal(entry.command, "/usr/local/bin/node");
    assert.deepEqual(entry.args, ["/opt/vidlens/dist/cli.js", "serve"]);
    assert.ok(entry.env, "env should be present");
    assert.equal(entry.env!.VIDLENS_DATA_DIR, "/home/user/.vidlens");
  });

  it("includes env vars when provided", () => {
    const entry = buildServerEntry({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/vidlens/dist/cli.js",
      dataDir: "/home/user/.vidlens",
      youtubeApiKey: "yt-key-123",
      geminiApiKey: "gem-key-456",
      googleApiKey: "google-key-789",
    });

    assert.equal(entry.env!.YOUTUBE_API_KEY, "yt-key-123");
    assert.equal(entry.env!.GEMINI_API_KEY, "gem-key-456");
    assert.equal(entry.env!.GOOGLE_API_KEY, "google-key-789");
    assert.equal(entry.env!.VIDLENS_DATA_DIR, "/home/user/.vidlens");
  });

  it("includes universal optional env vars when provided", () => {
    const entry = buildServerEntry({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/vidlens/dist/cli.js",
      dataDir: "/home/user/.vidlens",
      extraEnv: {
        OPENAI_API_KEY: "openai-key",
        SCRAPECREATORS_API_KEY: "scrape-key",
        BRAVE_API_KEY: "brave-key",
        SERPAPI_KEY: "serpapi-key",
        VIDLENS_WEB_SEARCH_PROVIDER: "brave",
        VIDLENS_STT_PROVIDER: "openai",
        VIDLENS_STT_LANGUAGE_HINT: "en",
        VIDLENS_WHISPER_MODEL_PATH: "/models/ggml.bin",
        VIDLENS_COOKIES_FROM_BROWSER: "chrome",
        VIDLENS_COOKIES_PROFILE: "Default",
        VIDLENS_YOUTUBE_COOKIES_FILE: "/cookies/youtube.txt",
        VIDLENS_X_COOKIES_FILE: "/cookies/x.txt",
        VIDLENS_INSTAGRAM_COOKIES_FILE: "/cookies/instagram.txt",
        VIDLENS_TIKTOK_COOKIES_FILE: "/cookies/tiktok.txt",
      },
    });

    assert.equal(entry.env!.OPENAI_API_KEY, "openai-key");
    assert.equal(entry.env!.SCRAPECREATORS_API_KEY, "scrape-key");
    assert.equal(entry.env!.BRAVE_API_KEY, "brave-key");
    assert.equal(entry.env!.SERPAPI_KEY, "serpapi-key");
    assert.equal(entry.env!.VIDLENS_WEB_SEARCH_PROVIDER, "brave");
    assert.equal(entry.env!.VIDLENS_STT_PROVIDER, "openai");
    assert.equal(entry.env!.VIDLENS_STT_LANGUAGE_HINT, "en");
    assert.equal(entry.env!.VIDLENS_WHISPER_MODEL_PATH, "/models/ggml.bin");
    assert.equal(entry.env!.VIDLENS_COOKIES_FROM_BROWSER, "chrome");
    assert.equal(entry.env!.VIDLENS_COOKIES_PROFILE, "Default");
    assert.equal(entry.env!.VIDLENS_YOUTUBE_COOKIES_FILE, "/cookies/youtube.txt");
    assert.equal(entry.env!.VIDLENS_X_COOKIES_FILE, "/cookies/x.txt");
    assert.equal(entry.env!.VIDLENS_INSTAGRAM_COOKIES_FILE, "/cookies/instagram.txt");
    assert.equal(entry.env!.VIDLENS_TIKTOK_COOKIES_FILE, "/cookies/tiktok.txt");
  });

  it("preserves existing env vars from existingEntry", () => {
    const entry = buildServerEntry({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/vidlens/dist/cli.js",
      dataDir: "/home/user/.vidlens",
      youtubeApiKey: "new-yt-key",
      existingEntry: {
        env: {
          CUSTOM_VAR: "keep-me",
          OLD_SETTING: "preserve",
        },
      },
    });

    assert.equal(entry.env!.CUSTOM_VAR, "keep-me");
    assert.equal(entry.env!.OLD_SETTING, "preserve");
    assert.equal(entry.env!.YOUTUBE_API_KEY, "new-yt-key");
    assert.equal(entry.env!.VIDLENS_DATA_DIR, "/home/user/.vidlens");
  });

  it("does not include API key env vars when not provided", () => {
    const entry = buildServerEntry({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/vidlens/dist/cli.js",
      dataDir: "/tmp/data",
    });

    assert.equal("YOUTUBE_API_KEY" in (entry.env ?? {}), false);
    assert.equal("GEMINI_API_KEY" in (entry.env ?? {}), false);
    assert.equal("GOOGLE_API_KEY" in (entry.env ?? {}), false);
  });
});

describe("mergeMcpConfigText", () => {
  it("merges without clobbering existing servers", () => {
    const existing = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "github-mcp"] },
      },
      theme: "dark",
    });

    const entry = {
      command: "/usr/local/bin/node",
      args: ["/repo/dist/cli.js", "serve"],
      env: { VIDLENS_DATA_DIR: "/tmp/data" },
    };

    const merged = mergeMcpConfigText(existing, "vidlens-mcp", entry);
    const parsed = JSON.parse(merged) as JsonObject;
    const servers = parsed.mcpServers as JsonObject;

    assert.ok(servers.github, "existing github server should be preserved");
    assert.ok(servers["vidlens-mcp"], "vidlens-mcp should be added");
    assert.equal(parsed.theme, "dark", "non-mcpServers fields should be preserved");
  });

  it("creates new config when none exists (undefined)", () => {
    const entry = {
      command: "/usr/local/bin/node",
      args: ["/repo/dist/cli.js", "serve"],
      env: { VIDLENS_DATA_DIR: "/tmp/data" },
    };

    const merged = mergeMcpConfigText(undefined, "vidlens-mcp", entry);
    const parsed = JSON.parse(merged) as JsonObject;
    const servers = parsed.mcpServers as JsonObject;

    assert.ok(servers["vidlens-mcp"], "vidlens-mcp should be present");
    const vidlens = servers["vidlens-mcp"] as { command: string; args: string[] };
    assert.equal(vidlens.command, "/usr/local/bin/node");
  });

  it("creates new config when existing text is empty string", () => {
    const entry = {
      command: "/usr/local/bin/node",
      args: ["/repo/dist/cli.js", "serve"],
      env: { VIDLENS_DATA_DIR: "/tmp/data" },
    };

    const merged = mergeMcpConfigText("", "vidlens-mcp", entry);
    const parsed = JSON.parse(merged) as JsonObject;
    const servers = parsed.mcpServers as JsonObject;

    assert.ok(servers["vidlens-mcp"], "vidlens-mcp should be present");
  });

  it("updates existing vidlens-mcp entry without duplicating", () => {
    const existing = JSON.stringify({
      mcpServers: {
        "vidlens-mcp": {
          command: "/old/node",
          args: ["/old/cli.js", "serve"],
          env: { VIDLENS_DATA_DIR: "/old/data", CUSTOM: "keep" },
        },
      },
    });

    const entry = {
      command: "/new/node",
      args: ["/new/cli.js", "serve"],
      env: { VIDLENS_DATA_DIR: "/new/data" },
    };

    const merged = mergeMcpConfigText(existing, "vidlens-mcp", entry);
    const parsed = JSON.parse(merged) as JsonObject;
    const servers = parsed.mcpServers as JsonObject;
    const vidlens = servers["vidlens-mcp"] as { command: string; env: Record<string, string> };

    assert.equal(vidlens.command, "/new/node");
    assert.equal(vidlens.env.VIDLENS_DATA_DIR, "/new/data");
    // Existing custom env vars should be preserved
    assert.equal(vidlens.env.CUSTOM, "keep");
  });
});

describe("inspectMcpConfigText", () => {
  it("detects registered server", () => {
    const config = JSON.stringify({
      mcpServers: {
        "vidlens-mcp": {
          command: "node",
          args: ["cli.js"],
          env: { YOUTUBE_API_KEY: "key" },
        },
      },
    });

    const result = inspectMcpConfigText(config);
    assert.equal(result.status, "registered");
    assert.deepEqual(result.envKeys, ["YOUTUBE_API_KEY"]);
  });

  it("detects missing server in existing config", () => {
    const config = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["github-mcp"] },
      },
    });

    const result = inspectMcpConfigText(config);
    assert.equal(result.status, "missing");
    assert.deepEqual(result.envKeys, []);
  });

  it("reports invalid_json for malformed JSON", () => {
    const result = inspectMcpConfigText("{not valid json");
    assert.equal(result.status, "invalid_json");
    assert.ok(result.error, "should have an error message");
  });

  it("reports invalid_json when root is not an object", () => {
    const result = inspectMcpConfigText('"just a string"');
    assert.equal(result.status, "invalid_json");
  });

  it("reports missing when no mcpServers key exists", () => {
    const result = inspectMcpConfigText(JSON.stringify({ theme: "dark" }));
    assert.equal(result.status, "missing");
  });
});

describe("inspectMcpConfigPath", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it("returns not_found for missing file", () => {
    const result = inspectMcpConfigPath("/nonexistent/path/config.json");
    assert.equal(result.status, "not_found");
    assert.equal(result.path, "/nonexistent/path/config.json");
  });

  it("returns not_found for undefined path", () => {
    const result = inspectMcpConfigPath(undefined);
    assert.equal(result.status, "not_found");
  });

  it("detects registered server in existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vidlens-mcp-inspect-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "vidlens-mcp": {
          command: "node",
          args: ["cli.js"],
          env: { VIDLENS_DATA_DIR: "/tmp" },
        },
      },
    }));

    const result = inspectMcpConfigPath(configPath);
    assert.equal(result.status, "registered");
    assert.equal(result.path, configPath);
    assert.ok(result.serverEntry, "should have serverEntry");
    assert.ok(result.envKeys.includes("VIDLENS_DATA_DIR"), "should include VIDLENS_DATA_DIR in envKeys");
  });

  it("detects missing server in existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "vidlens-mcp-inspect-miss-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["github-mcp"] },
      },
    }));

    const result = inspectMcpConfigPath(configPath);
    assert.equal(result.status, "missing");
    assert.equal(result.path, configPath);
  });
});

describe("setup command via runCli", () => {
  it("setup with no --client defaults to targeting claude_desktop", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-default-"));
    const stdout: string[] = [];

    const exitCode = await runCli(["setup", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_desktop" as const,
          name: "Claude Desktop",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "config_file" as const,
          configPath: join(configDir, "claude.json"),
        },
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, "codex.json"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: "/Users/test",
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    assert.equal(exitCode, 0);
    const output = stdout.join("");
    assert.ok(output.includes("Claude Desktop"), "should include Claude Desktop section");
  });

  it("setup with --client=claude_desktop targets only Claude Desktop", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-cd-"));
    const stdout: string[] = [];
    const cdConfigPath = join(configDir, "claude.json");

    const exitCode = await runCli(["setup", "--client=claude_desktop", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_desktop" as const,
          name: "Claude Desktop",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "config_file" as const,
          configPath: cdConfigPath,
        },
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, "codex.json"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: "/Users/test",
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    assert.equal(exitCode, 0);
    const output = stdout.join("");
    assert.ok(output.includes("Claude Desktop"), "should include Claude Desktop section");
  });

  it("setup with --print-only does not write files", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-po-"));
    const cdConfigPath = join(configDir, "claude.json");
    // Do NOT create the file -- we'll verify it still doesn't exist after setup

    await runCli(["setup", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_desktop" as const,
          name: "Claude Desktop",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "config_file" as const,
          configPath: cdConfigPath,
        },
      ],
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: "/Users/test",
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    // File should not have been created
    let fileExists = false;
    try {
      readFileSync(cdConfigPath, "utf8");
      fileExists = true;
    } catch {
      fileExists = false;
    }
    assert.equal(fileExists, false, "config file should NOT be created in print-only mode");
  });

  it("runCli version prints the package version", async () => {
    const stdout: string[] = [];

    const exitCode = await runCli(["version"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.2.3" },
      detectClients: () => [],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: "/Users/test",
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    assert.equal(exitCode, 0);
    assert.equal(stdout.join(""), "vidlens-mcp v1.2.3\n");
  });

  it("auto-detect selects both Claude Desktop and Claude Code when both detected", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-auto-"));
    const stdout: string[] = [];

    await runCli(["setup", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_desktop" as const,
          name: "Claude Desktop",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "config_file" as const,
          configPath: join(configDir, "claude.json"),
        },
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude", "settings.json"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    const output = stdout.join("");
    assert.ok(output.includes("Claude Desktop"), "should include Claude Desktop section");
    assert.ok(output.includes("Claude Code"), "should include Claude Code section");
  });

  it("--client=claude_code targets only Claude Code", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-cc-"));
    const stdout: string[] = [];

    await runCli(["setup", "--client=claude_code", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_desktop" as const,
          name: "Claude Desktop",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "config_file" as const,
          configPath: join(configDir, "claude.json"),
        },
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude", "settings.json"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    const output = stdout.join("");
    assert.ok(!output.includes("Claude Desktop"), "should NOT include Claude Desktop section");
    assert.ok(output.includes("Claude Code"), "should include Claude Code section");
  });

  it("Claude Code write targets ~/.claude.json user MCP registry", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-ccwrite-"));
    const stdout: string[] = [];

    await runCli(["setup", "--client=claude_code"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude", "settings.json"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    const settingsPath = join(configDir, ".claude.json");
    assert.ok(existsSync(settingsPath), ".claude.json should have been created");
    const content = JSON.parse(readFileSync(settingsPath, "utf8")) as JsonObject;
    const servers = content.mcpServers as JsonObject;
    assert.ok(servers["vidlens-mcp"], "vidlens-mcp should be registered in .claude.json");
  });

  it("Claude Code setup uses claude mcp add-json when the CLI is available", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-cccli-"));
    const stdout: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "--client=claude_code"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude.json"),
          binary: "/usr/local/bin/claude",
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        if (args.join(" ") === "mcp list") {
          return {
            status: 0,
            stdout: "vidlens-mcp: /usr/local/bin/node /repo/dist/cli.js serve - ✓ Connected\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "Added stdio MCP server vidlens-mcp to user config\n", stderr: "" };
      },
    });

    const addCall = calls.find((call) => call.args[0] === "mcp" && call.args[1] === "add-json");
    assert.ok(addCall, "setup should register through claude mcp add-json");
    assert.equal(addCall.args[3], "user");
    assert.equal(addCall.args[4], "vidlens-mcp");
    const entry = JSON.parse(addCall.args[5] ?? "{}") as JsonObject;
    assert.equal(entry.command, "/usr/local/bin/node");
    assert.deepEqual(entry.args, ["/repo/dist/cli.js", "serve"]);
    assert.ok(stdout.join("").includes("Claude Code CLI registry"), "output should explain the CLI registry method");
    assert.ok(stdout.join("").includes("connected in `claude mcp list`"), "output should report verification");
    assert.ok(!existsSync(join(configDir, ".claude.json")), "test fake CLI did not need direct file fallback");
  });

  it("Claude Code setup falls back to ~/.claude.json when claude mcp add-json fails", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-ccfallback-"));
    const stdout: string[] = [];

    await runCli(["setup", "--client=claude_code"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude.json"),
          binary: "/usr/local/bin/claude",
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      runCommand: (_command, args) => {
        if (args.join(" ") === "mcp list") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "failed" };
      },
    });

    const settingsPath = join(configDir, ".claude.json");
    assert.ok(existsSync(settingsPath), ".claude.json should be written as a fallback");
    const content = JSON.parse(readFileSync(settingsPath, "utf8")) as JsonObject;
    const servers = content.mcpServers as JsonObject;
    assert.ok(servers["vidlens-mcp"], "vidlens-mcp should be registered in fallback file");
    assert.ok(stdout.join("").includes("direct user registry file"), "output should explain fallback method");
    assert.ok(stdout.join("").includes("claude mcp add-json was unavailable or failed"), "output should explain why fallback was used");
  });

  it("Claude Code setup avoids passing secret env values through claude mcp add-json args", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-ccsecret-"));
    const stdout: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "--client=claude_code", "--youtube-api-key=yt-secret"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude.json"),
          binary: "/usr/local/bin/claude",
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: "vidlens-mcp: /usr/local/bin/node /repo/dist/cli.js serve - ✓ Connected\n",
          stderr: "",
        };
      },
    });

    assert.ok(!calls.some((call) => call.args[0] === "mcp" && call.args[1] === "add-json"), "secret-bearing config should not be passed through add-json args");
    assert.ok(existsSync(join(configDir, ".claude.json")), ".claude.json should be written directly");
    assert.ok(stdout.join("").includes("keeps API keys and cookie settings out of command arguments"));
  });

  it("setup reuses existing MCP env values instead of re-prompting for saved keys", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-existing-env-"));
    const settingsPath = join(configDir, ".claude.json");
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: {
        "vidlens-mcp": {
          command: "/usr/local/bin/node",
          args: ["/repo/dist/cli.js", "serve"],
          env: {
            VIDLENS_DATA_DIR: "/tmp/vidlens",
            YOUTUBE_API_KEY: "yt-existing",
            GEMINI_API_KEY: "gem-existing",
            OPENAI_API_KEY: "openai-existing",
            BRAVE_API_KEY: "brave-existing",
            VIDLENS_COOKIES_FROM_BROWSER: "chrome",
          },
        },
      },
    }), "utf8");
    const prompts: string[] = [];

    await runCli(["setup", "--client=claude_code", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: settingsPath,
        },
      ],
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      promptLine: async (question) => {
        prompts.push(question);
        return "n";
      },
    });

    assert.ok(!prompts.some((prompt) => prompt.includes("Key [Enter to skip]")), "saved key env should suppress first-run key prompts");
  });

  it("setup does not prompt for or persist ambient shell keys by default", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-zero-config-"));
    const binDir = join(configDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeYtDlp = join(binDir, "yt-dlp");
    writeFileSync(fakeYtDlp, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeYtDlp, 0o755);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prompts: string[] = [];

    await runCli(["setup", "--client=codex", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".codex", "config.toml"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: (text) => { stderr.push(text); },
      env: {
        PATH: binDir,
        OPENAI_API_KEY: "sk-shell-openai",
        GEMINI_API_KEY: "shell-gemini",
        YOUTUBE_API_KEY: "shell-youtube",
        BRAVE_API_KEY: "shell-brave",
      },
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      promptLine: async (question) => {
        prompts.push(question);
        return "";
      },
    });

    const output = stdout.join("");
    const setupOutput = stderr.join("");
    assert.ok(setupOutput.includes("Capability uplift"));
    assert.ok(setupOutput.includes("VidLens starts free"));
    assert.ok(setupOutput.includes("More video types need more helpers"));
    assert.ok(setupOutput.includes("Keys are only stored when you pass them or run --advanced"));
    assert.ok(setupOutput.includes("OPENAI_API_KEY"));
    assert.ok(setupOutput.includes("BRAVE_API_KEY or SERPAPI_KEY"));
    assert.ok(setupOutput.includes("Continuing with free core setup"));
    assert.deepEqual(prompts, []);
    assert.ok(!output.includes("OPENAI_API_KEY ="), "ambient OpenAI key should not be persisted");
    assert.ok(!output.includes("GEMINI_API_KEY ="), "ambient Gemini key should not be persisted");
    assert.ok(!output.includes("YOUTUBE_API_KEY ="), "ambient YouTube key should not be persisted");
    assert.ok(!output.includes("BRAVE_API_KEY ="), "ambient Brave key should not be persisted");
    assert.ok(!output.includes("sk-shell-openai"), "ambient OpenAI key value should not be printed");
    assert.ok(!output.includes("shell-gemini"), "ambient Gemini key value should not be printed");
    assert.ok(!output.includes("shell-youtube"), "ambient YouTube key value should not be printed");
    assert.ok(!output.includes("shell-brave"), "ambient Brave key value should not be printed");
  });

  it("setup explains missing ffmpeg before social visual indexing fails", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-ffmpeg-"));
    const binDir = join(configDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeYtDlp = join(binDir, "yt-dlp");
    writeFileSync(fakeYtDlp, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeYtDlp, 0o755);
    const stderr: string[] = [];

    await runCli(["setup", "--client=codex", "--print-only", "--advanced"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".codex", "config.toml"),
        },
      ],
      writeStdout: () => undefined,
      writeStderr: (text) => { stderr.push(text); },
      env: { PATH: binDir },
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      promptLine: async () => "n",
    });

    const output = stderr.join("");
    assert.ok(output.includes("ffmpeg/ffprobe not found"));
    assert.ok(output.includes("Instagram/TikTok/X reels"));
    assert.ok(output.includes("brew install ffmpeg"));
  });

  it("--print-only does not write files for Claude Code", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-ccpo-"));

    await runCli(["setup", "--client=claude_code", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "claude_code" as const,
          name: "Claude Code",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".claude", "settings.json"),
        },
      ],
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    const settingsPath = join(configDir, ".claude.json");
    assert.ok(!existsSync(settingsPath), ".claude.json should NOT be created in print-only mode");
  });

  it("advanced setup prompts explain defaults and report detected STT/search choices", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-advanced-prompts-"));
    const binDir = join(configDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeYtDlp = join(binDir, "yt-dlp");
    writeFileSync(fakeYtDlp, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeYtDlp, 0o755);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const answers = ["", "en", "", "", "chrome", "person@example.com", "n"];

    await runCli([
      "setup",
      "--client=codex",
      "--print-only",
      "--advanced",
      "--youtube-api-key=yt-key",
      "--gemini-api-key=gem-key",
      "--openai-api-key=openai-key",
      "--scrapecreators-api-key=scrape-key",
      "--brave-api-key=brave-key",
    ], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".codex", "config.toml"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: (text) => { stderr.push(text); },
      env: { PATH: binDir },
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      promptLine: async () => answers.shift() ?? "",
    });

    const output = stderr.join("");
    assert.ok(output.includes("Speech-to-text"));
    assert.ok(output.includes("Auto order: local whisper.cpp -> Gemini -> OpenAI -> none."));
    assert.ok(output.includes("Selected STT:"));
    assert.ok(output.includes("gemini"));
    assert.ok(output.includes("Web search"));
    assert.ok(output.includes("Auto order: Brave -> SerpAPI -> DuckDuckGo-lite."));
    assert.ok(output.includes("Selected Web search:"));
    assert.ok(output.includes("brave"));
    assert.ok(output.includes("Recommended: enter the browser where you are logged into X/Instagram/TikTok."));
    assert.ok(output.includes("Selected Cookies:"));
    assert.ok(output.includes("browser:chrome"));
    assert.ok(output.includes("That looks like an email address."));
    assert.ok(!stdout.join("").includes("person@example.com"));
  });

  it("Codex print-only setup includes universal env and redacts API key values", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-codex-universal-"));
    const stdout: string[] = [];

    await runCli([
      "setup",
      "--client=codex",
      "--print-only",
      "--openai-api-key=sk-openai-test",
      "--scrapecreators-api-key=sc-test-key",
      "--brave-api-key=brave-test-key",
      "--stt-provider=openai",
      "--cookies-from-browser=chrome",
      "--cookies-profile=Default",
    ], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: join(configDir, ".codex", "config.toml"),
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
      promptLine: async () => "n",
    });

    const output = stdout.join("");
    assert.ok(output.includes("Codex"), "should include Codex section");
    assert.ok(output.includes('OPENAI_API_KEY = "<set>"'), "should show OPENAI_API_KEY as configured but redacted");
    assert.ok(output.includes('SCRAPECREATORS_API_KEY = "<set>"'), "should show SCRAPECREATORS_API_KEY as configured but redacted");
    assert.ok(output.includes('BRAVE_API_KEY = "<set>"'), "should show BRAVE_API_KEY as configured but redacted");
    assert.ok(output.includes('VIDLENS_STT_PROVIDER = "openai"'), "should persist STT provider");
    assert.ok(output.includes('VIDLENS_COOKIES_FROM_BROWSER = "chrome"'), "should persist browser cookie source");
    assert.ok(output.includes('VIDLENS_COOKIES_PROFILE = "Default"'), "should persist browser cookie profile");
    assert.ok(!output.includes("sk-openai-test"), "should not print raw OpenAI key");
    assert.ok(!output.includes("brave-test-key"), "should not print raw Brave key");
  });

  it("Codex print-only setup redacts existing configured secrets", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-setup-codex-redact-existing-"));
    const codexConfigPath = join(configDir, ".codex", "config.toml");
    mkdirSync(dirname(codexConfigPath), { recursive: true });
    writeFileSync(codexConfigPath, `
[mcp_servers.vidlens-mcp]
command = "/usr/local/bin/node"
args = ["/repo/dist/cli.js", "serve"]

[mcp_servers.vidlens-mcp.env]
VIDLENS_DATA_DIR = "/tmp/vidlens"
OPENAI_API_KEY = "existing-openai-secret"
BRAVE_API_KEY = "existing-brave-secret"
VIDLENS_X_COOKIES_FILE = "/secret/x-cookies.txt"
`, "utf8");
    const stdout: string[] = [];

    await runCli(["setup", "--client=codex", "--print-only"], {
      startServer: async () => undefined,
      createService: () => ({}) as unknown as YouTubeService,
      packageMeta: { name: "vidlens-mcp", version: "1.0.0" },
      detectClients: () => [
        {
          clientId: "codex" as const,
          name: "Codex",
          detected: true,
          supportLevel: "supported" as const,
          installSurface: "mixed" as const,
          configPath: codexConfigPath,
        },
      ],
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: () => undefined,
      env: {},
      platform: "darwin",
      homeDir: configDir,
      nodePath: "/usr/local/bin/node",
      cliPath: "/repo/dist/cli.js",
      now: () => new Date("2026-03-16T00:00:00.000Z"),
    });

    const output = stdout.join("");
    assert.ok(output.includes('OPENAI_API_KEY = "<set>"'));
    assert.ok(output.includes('BRAVE_API_KEY = "<set>"'));
    assert.ok(output.includes('VIDLENS_X_COOKIES_FILE = "<set>"'));
    assert.ok(!output.includes("existing-openai-secret"));
    assert.ok(!output.includes("existing-brave-secret"));
    assert.ok(!output.includes("/secret/x-cookies.txt"));
  });
});
