import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("Claude Code write targets ~/.claude/settings.json", async () => {
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

    const settingsPath = join(configDir, ".claude", "settings.json");
    assert.ok(existsSync(settingsPath), "settings.json should have been created");
    const content = JSON.parse(readFileSync(settingsPath, "utf8")) as JsonObject;
    const servers = content.mcpServers as JsonObject;
    assert.ok(servers["vidlens-mcp"], "vidlens-mcp should be registered in settings.json");
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

    const settingsPath = join(configDir, ".claude", "settings.json");
    assert.ok(!existsSync(settingsPath), "settings.json should NOT be created in print-only mode");
  });
});
