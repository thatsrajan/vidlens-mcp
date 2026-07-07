import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildServerEntry,
  inspectMcpConfigText,
  mergeMcpConfigText,
  parseCliArgs,
  runCli,
  upsertMcpServerConfig,
} from "../lib/cli-runtime.js";
import type { YouTubeService } from "../lib/youtube-service.js";

test("parseCliArgs defaults to serve with no arguments", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.command, "serve");
  assert.deepEqual(parsed.clientIds, []);
  assert.equal(parsed.printOnly, false);
});

test("parseCliArgs parses setup flags and client aliases", () => {
  const parsed = parseCliArgs([
    "setup",
    "--client",
    "claude",
    "--client=ultra",
    "--data-dir",
    "/tmp/vidlens-mcp",
    "--youtube-api-key",
    "yt-key",
    "--gemini-api-key=gem-key",
    "--print-only",
  ]);

  assert.equal(parsed.command, "setup");
  assert.deepEqual(parsed.clientIds, ["claude_desktop", "chatgpt_desktop"]);
  assert.equal(parsed.dataDir, "/tmp/vidlens-mcp");
  assert.equal(parsed.youtubeApiKey, "yt-key");
  assert.equal(parsed.geminiApiKey, "gem-key");
  assert.equal(parsed.printOnly, true);
});

test("parseCliArgs parses --yes and -y into assumeYes", () => {
  assert.equal(parseCliArgs(["setup", "--yes"]).assumeYes, true);
  assert.equal(parseCliArgs(["setup", "-y"]).assumeYes, true);
  assert.equal(parseCliArgs(["setup"]).assumeYes, undefined);
});

test("buildServerEntry preserves existing env while updating vidlens-mcp fields", () => {
  const entry = buildServerEntry({
    nodePath: "/usr/local/bin/node",
    cliPath: "/repo/dist/cli.js",
    dataDir: "/Users/test/Library/Application Support/vidlens-mcp",
    youtubeApiKey: "yt-key",
    existingEntry: {
      env: {
        EXISTING_FLAG: "keep-me",
        GEMINI_API_KEY: "already-set",
      },
    },
  });

  assert.equal(entry.command, "/usr/local/bin/node");
  assert.deepEqual(entry.args, ["/repo/dist/cli.js", "serve"]);
  assert.equal(entry.env?.EXISTING_FLAG, "keep-me");
  assert.equal(entry.env?.YOUTUBE_API_KEY, "yt-key");
  assert.equal(entry.env?.GEMINI_API_KEY, "already-set");
  assert.equal(entry.env?.VIDLENS_DATA_DIR, "/Users/test/Library/Application Support/vidlens-mcp");
});

test("mergeMcpConfigText safely preserves other MCP servers", () => {
  const merged = mergeMcpConfigText(
    JSON.stringify(
      {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
        },
        theme: "dark",
      },
      null,
      2,
    ),
    "vidlens-mcp",
    {
      command: "/usr/local/bin/node",
      args: ["/repo/dist/cli.js", "serve"],
      env: {
        VIDLENS_DATA_DIR: "/Users/test/Library/Application Support/vidlens-mcp",
      },
    },
  );

  const parsed = JSON.parse(merged) as {
    theme: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.equal(parsed.theme, "dark");
  assert.deepEqual(parsed.mcpServers.github.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.equal(parsed.mcpServers["vidlens-mcp"]?.command, "/usr/local/bin/node");
  assert.deepEqual(parsed.mcpServers["vidlens-mcp"]?.args, ["/repo/dist/cli.js", "serve"]);
});

test("inspectMcpConfigText reports registered server env keys", () => {
  const inspection = inspectMcpConfigText(
    JSON.stringify({
      mcpServers: {
        "vidlens-mcp": {
          command: "/usr/local/bin/node",
          args: ["/repo/dist/cli.js", "serve"],
          env: {
            VIDLENS_DATA_DIR: "/tmp/vidlens-mcp",
            GEMINI_API_KEY: "secret",
          },
        },
      },
    }),
  );

  assert.equal(inspection.status, "registered");
  assert.deepEqual(inspection.envKeys.sort(), ["GEMINI_API_KEY", "VIDLENS_DATA_DIR"]);
});

test("upsertMcpServerConfig writes a safe merged config without removing other servers", () => {
  const configDir = mkdtempSync(join(tmpdir(), "vidlens-mcp-cli-"));
  const configPath = join(configDir, "claude_desktop_config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
        },
      },
      null,
      2,
    ),
  );

  const result = upsertMcpServerConfig({
    configPath,
    entry: {
      command: "/usr/local/bin/node",
      args: ["/repo/dist/cli.js", "serve"],
      env: {
        VIDLENS_DATA_DIR: "/tmp/vidlens-mcp",
      },
    },
    now: new Date("2026-03-14T17:10:00.000Z"),
  });

  const written = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.equal(result.changed, true);
  assert.equal(Boolean(result.backupPath), true);
  assert.deepEqual(written.mcpServers.github.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(written.mcpServers["vidlens-mcp"]?.args, ["/repo/dist/cli.js", "serve"]);
});

test("runCli routes default command to the stdio server", async () => {
  let started = 0;

  const exitCode = await runCli([], {
    startServer: async () => {
      started += 1;
    },
    createService: () => ({}) as unknown as YouTubeService,
    packageMeta: { name: "vidlens-mcp", version: "0.2.16" },
    detectClients: () => [],
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    env: {},
    platform: "darwin",
    homeDir: "/Users/test",
    nodePath: "/usr/local/bin/node",
    cliPath: "/repo/dist/cli.js",
    now: () => new Date("2026-03-14T17:10:00.000Z"),
  });

  assert.equal(exitCode, 0);
  assert.equal(started, 1);
});

test("runCli version prints the package version", async () => {
  const stdout: string[] = [];

  const exitCode = await runCli(["version"], {
    startServer: async () => undefined,
    createService: () => ({}) as unknown as YouTubeService,
    packageMeta: { name: "vidlens-mcp", version: "0.2.16" },
    detectClients: () => [],
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: () => undefined,
    env: {},
    platform: "darwin",
    homeDir: "/Users/test",
    nodePath: "/usr/local/bin/node",
    cliPath: "/repo/dist/cli.js",
    now: () => new Date("2026-03-14T17:10:00.000Z"),
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.join(""), "vidlens-mcp v0.2.16\n");
});
