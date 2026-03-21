import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectKnownClients,
  keyTransparencySummary,
  readPackageMetadata,
  resolveClaudeCodeUserConfigPath,
  resolveDefaultDataDir,
  type ClientDetectionSummary,
  type KnownClientId,
} from "./install-diagnostics.js";
import type { YouTubeService } from "./youtube-service.js";

type JsonObject = Record<string, unknown>;

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfigInspection {
  path?: string;
  status: "not_found" | "registered" | "missing" | "invalid_json";
  error?: string;
  serverEntry?: JsonObject;
  envKeys: string[];
}

export interface UpsertConfigResult {
  path: string;
  changed: boolean;
  created: boolean;
  backupPath?: string;
  configText: string;
}

export interface ParsedCliArgs {
  command: "serve" | "version" | "doctor" | "setup" | "help";
  clientIds: KnownClientId[];
  noLive: boolean;
  printOnly: boolean;
  dataDir?: string;
  youtubeApiKey?: string;
  geminiApiKey?: string;
  googleApiKey?: string;
}

export interface CliDeps {
  startServer: () => Promise<void>;
  createService: () => YouTubeService | Promise<YouTubeService>;
  packageMeta: ReturnType<typeof readPackageMetadata>;
  detectClients: () => ClientDetectionSummary[];
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  nodePath: string;
  cliPath: string;
  now: () => Date;
  isNpx: boolean;
  promptLine: (question: string) => Promise<string>;
}

class CliUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUserError";
  }
}

export async function runCli(args: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const resolvedDeps = createCliDeps(deps);
  const parsed = parseCliArgs(args);

  switch (parsed.command) {
    case "serve":
      suppressExperimentalWarnings();
      await resolvedDeps.startServer();
      return 0;
    case "version":
      resolvedDeps.writeStdout(`${resolvedDeps.packageMeta.name} v${resolvedDeps.packageMeta.version}\n`);
      return 0;
    case "doctor":
      resolvedDeps.writeStdout(await renderDoctorReport(parsed, resolvedDeps));
      return 0;
    case "setup": {
      const ver = resolvedDeps.packageMeta.version;
      resolvedDeps.writeStderr(`
  \x1b[31m▶\x1b[0m \x1b[1mVidLens MCP\x1b[0m v${ver}
    YouTube intelligence layer for AI agents
    41 tools · zero config
`);
      const hasYoutubeKey = Boolean(parsed.youtubeApiKey || resolvedDeps.env.YOUTUBE_API_KEY);
      const hasGeminiKey = Boolean(parsed.geminiApiKey || resolvedDeps.env.GEMINI_API_KEY || parsed.googleApiKey || resolvedDeps.env.GOOGLE_API_KEY);
      if (!hasYoutubeKey || !hasGeminiKey) {
        resolvedDeps.writeStderr("  API keys are optional — everything works without them.\n\n");
      }
      if (!hasYoutubeKey) {
        resolvedDeps.writeStderr("  \x1b[33mYOUTUBE_API_KEY\x1b[0m\n");
        resolvedDeps.writeStderr("    Unlocks: higher-fidelity metadata, search via API, subscriber counts\n");
        resolvedDeps.writeStderr("    Get one free: \x1b[4mhttps://console.cloud.google.com/apis/credentials\x1b[0m\n");
        const key = await resolvedDeps.promptLine("    Enter key (or press Enter to skip): ");
        if (key) parsed.youtubeApiKey = key;
        resolvedDeps.writeStderr("\n");
      }
      if (!hasGeminiKey) {
        resolvedDeps.writeStderr("  \x1b[33mGEMINI_API_KEY\x1b[0m\n");
        resolvedDeps.writeStderr("    Unlocks: semantic search, visual search, AI-powered descriptions\n");
        resolvedDeps.writeStderr("    Get one free: \x1b[4mhttps://aistudio.google.com/apikey\x1b[0m\n");
        const key = await resolvedDeps.promptLine("    Enter key (or press Enter to skip): ");
        if (key) parsed.geminiApiKey = key;
        resolvedDeps.writeStderr("\n");
      }
      // If running via npx and no global binary exists, offer to install globally
      if (resolvedDeps.isNpx) {
        const pkgName = resolvedDeps.packageMeta.name;
        const globalBin = findGlobalBinary(pkgName);
        if (!globalBin) {
          resolvedDeps.writeStderr(`  \x1b[33m⚡ Startup speed\x1b[0m\n`);
          resolvedDeps.writeStderr(`    npx checks the npm registry on every Claude Desktop restart (1-30s delay).\n`);
          resolvedDeps.writeStderr(`    A global install eliminates this — server starts in <0.5s.\n`);
          const answer = await resolvedDeps.promptLine("    Install globally now? (Y/n): ");
          if (!answer || answer.trim().toLowerCase() !== "n") {
            resolvedDeps.writeStderr(`    Installing ${pkgName} globally...\n`);
            try {
              const { execSync } = await import("node:child_process");
              execSync(`npm install -g ${pkgName}`, { stdio: "inherit" });
              resolvedDeps.writeStderr(`    \x1b[32m✓\x1b[0m Installed globally.\n`);
            } catch {
              resolvedDeps.writeStderr(`    \x1b[31m✗\x1b[0m Global install failed. Run manually: npm install -g ${pkgName}\n`);
            }
          }
          resolvedDeps.writeStderr("\n");
        }
      }

      resolvedDeps.writeStdout(renderSetupReport(parsed, resolvedDeps));
      return 0;
    }
    case "help":
      resolvedDeps.writeStdout(renderHelp(resolvedDeps.packageMeta.name));
      return 0;
    default:
      return 0;
  }
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const args = [...argv];
  const first = args[0];
  let command: ParsedCliArgs["command"] = "serve";

  if (first && !first.startsWith("-")) {
    if (["serve", "version", "doctor", "setup", "help"].includes(first)) {
      command = first as ParsedCliArgs["command"];
      args.shift();
    } else {
      throw new CliUserError(`Unknown command: ${first}`);
    }
  }

  const parsed: ParsedCliArgs = {
    command,
    clientIds: [],
    noLive: false,
    printOnly: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }

    if (token === "-h" || token === "--help") {
      parsed.command = "help";
      continue;
    }

    if (token === "--no-live") {
      parsed.noLive = true;
      continue;
    }

    if (token === "--print-only" || token === "--dry-run") {
      parsed.printOnly = true;
      continue;
    }

    if (token.startsWith("--client=")) {
      parsed.clientIds.push(parseClientId(token.slice("--client=".length)));
      continue;
    }

    if (token === "--client") {
      parsed.clientIds.push(parseClientId(requireValue(args.shift(), "--client")));
      continue;
    }

    if (token.startsWith("--data-dir=")) {
      parsed.dataDir = token.slice("--data-dir=".length);
      continue;
    }

    if (token === "--data-dir") {
      parsed.dataDir = requireValue(args.shift(), "--data-dir");
      continue;
    }

    if (token.startsWith("--youtube-api-key=")) {
      parsed.youtubeApiKey = token.slice("--youtube-api-key=".length);
      continue;
    }

    if (token === "--youtube-api-key") {
      parsed.youtubeApiKey = requireValue(args.shift(), "--youtube-api-key");
      continue;
    }

    if (token.startsWith("--gemini-api-key=")) {
      parsed.geminiApiKey = token.slice("--gemini-api-key=".length);
      continue;
    }

    if (token === "--gemini-api-key") {
      parsed.geminiApiKey = requireValue(args.shift(), "--gemini-api-key");
      continue;
    }

    if (token.startsWith("--google-api-key=")) {
      parsed.googleApiKey = token.slice("--google-api-key=".length);
      continue;
    }

    if (token === "--google-api-key") {
      parsed.googleApiKey = requireValue(args.shift(), "--google-api-key");
      continue;
    }

    throw new CliUserError(`Unknown flag: ${token}`);
  }

  return parsed;
}

export function buildServerEntry(options: {
  nodePath: string;
  cliPath: string;
  dataDir: string;
  youtubeApiKey?: string;
  geminiApiKey?: string;
  googleApiKey?: string;
  existingEntry?: JsonObject;
  useNpx?: boolean;
  packageName?: string;
}): McpServerEntry {
  const existingEnv = isRecord(options.existingEntry?.env)
    ? stringifyEnv(options.existingEntry.env)
    : {};
  const env: Record<string, string> = {
    ...existingEnv,
    VIDLENS_DATA_DIR: options.dataDir,
  };

  if (options.youtubeApiKey) {
    env.YOUTUBE_API_KEY = options.youtubeApiKey;
  }
  if (options.geminiApiKey) {
    env.GEMINI_API_KEY = options.geminiApiKey;
  }
  if (options.googleApiKey) {
    env.GOOGLE_API_KEY = options.googleApiKey;
  }

  // Prefer global install binary over npx to avoid npm resolution on every startup.
  // npx runs a full registry check each time, adding 1-30s of latency.
  if (options.useNpx) {
    const globalBin = findGlobalBinary(options.packageName ?? "vidlens-mcp");
    if (globalBin) {
      return { command: globalBin, args: ["serve"], env };
    }
    return {
      command: "npx",
      args: ["-y", options.packageName ?? "vidlens-mcp", "serve"],
      env,
    };
  }

  return {
    command: options.nodePath,
    args: [options.cliPath, "serve"],
    env,
  };
}

export function inspectMcpConfigText(configText: string, serverName = "vidlens-mcp"): McpConfigInspection {
  try {
    const parsed = JSON.parse(configText) as unknown;
    if (!isRecord(parsed)) {
      return {
        status: "invalid_json",
        error: "Config root must be a JSON object.",
        envKeys: [],
      };
    }

    const mcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
    const serverEntry = mcpServers && isRecord(mcpServers[serverName]) ? (mcpServers[serverName] as JsonObject) : undefined;

    return {
      status: serverEntry ? "registered" : "missing",
      serverEntry,
      envKeys: serverEntry && isRecord(serverEntry.env) ? Object.keys(serverEntry.env) : [],
    };
  } catch (error) {
    return {
      status: "invalid_json",
      error: toMessage(error),
      envKeys: [],
    };
  }
}

export function inspectMcpConfigPath(configPath: string | undefined, serverName = "vidlens-mcp"): McpConfigInspection {
  if (!configPath || !existsSync(configPath)) {
    return {
      path: configPath,
      status: "not_found",
      envKeys: [],
    };
  }

  const result = inspectMcpConfigText(readFileSync(configPath, "utf8"), serverName);
  result.path = configPath;
  return result;
}

export function mergeMcpConfigText(
  existingText: string | undefined,
  serverName: string,
  serverEntry: McpServerEntry,
): string {
  const root = parseConfigRoot(existingText);
  const mcpServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  const existingEntry = isRecord(mcpServers[serverName]) ? (mcpServers[serverName] as JsonObject) : undefined;
  const existingEnv = existingEntry && isRecord(existingEntry.env)
    ? stringifyEnv(existingEntry.env)
    : {};
  const merged: McpServerEntry = {
    command: serverEntry.command,
    args: [...serverEntry.args],
    env: { ...existingEnv, ...serverEntry.env },
  };

  const nextRoot: JsonObject = {
    ...root,
    mcpServers: {
      ...mcpServers,
      [serverName]: merged,
    },
  };

  return `${JSON.stringify(nextRoot, null, 2)}\n`;
}

export function upsertMcpServerConfig(options: {
  configPath: string;
  serverName?: string;
  entry: McpServerEntry;
  printOnly?: boolean;
  now?: Date;
}): UpsertConfigResult {
  const serverName = options.serverName ?? "vidlens-mcp";
  const existingText = existsSync(options.configPath) ? readFileSync(options.configPath, "utf8") : undefined;
  const nextText = mergeMcpConfigText(existingText, serverName, options.entry);
  const changed = existingText !== nextText;
  const created = !existingText;

  let backupPath: string | undefined;
  if (!options.printOnly && changed) {
    mkdirSync(dirname(options.configPath), { recursive: true });
    if (existingText !== undefined) {
      const timestamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
      backupPath = `${options.configPath}.bak.${timestamp}`;
      copyFileSync(options.configPath, backupPath);
    }
    writeFileSync(options.configPath, nextText, "utf8");
  }

  return {
    path: options.configPath,
    changed,
    created,
    backupPath,
    configText: nextText,
  };
}

function createCliDeps(overrides: Partial<CliDeps>): CliDeps {
  const env = overrides.env ?? process.env;
  const cliPath = overrides.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
  return {
    startServer: overrides.startServer ?? (async () => {
      const { startStdioServer } = await import("../server/mcp-server.js");
      return startStdioServer();
    }),
    createService: overrides.createService ?? (async () => {
      const { YouTubeService } = await import("./youtube-service.js");
      return new YouTubeService();
    }),
    packageMeta: overrides.packageMeta ?? readPackageMetadata(),
    detectClients: overrides.detectClients ?? (() => detectKnownClients()),
    writeStdout: overrides.writeStdout ?? ((text) => process.stdout.write(text)),
    writeStderr: overrides.writeStderr ?? ((text) => process.stderr.write(text)),
    env,
    platform: overrides.platform ?? process.platform,
    homeDir: overrides.homeDir ?? homedir(),
    nodePath: overrides.nodePath ?? process.execPath,
    cliPath,
    now: overrides.now ?? (() => new Date()),
    isNpx: overrides.isNpx ?? isNpxInvocation(env, cliPath),
    promptLine: overrides.promptLine ?? defaultPromptLine,
  };
}

async function renderDoctorReport(parsed: ParsedCliArgs, deps: CliDeps): Promise<string> {
  const service = await deps.createService();
  const health = await service.checkSystemHealth({ runLiveChecks: !parsed.noLive });
  const clients = deps.detectClients();
  const claudeDesktop = clients.find((client) => client.clientId === "claude_desktop");
  const claudeInspection = inspectMcpConfigPath(claudeDesktop?.configPath);
  const claudeCode = clients.find((client) => client.clientId === "claude_code");
  const claudeCodeConfigPath = resolveClaudeCodeUserConfigPath(deps.homeDir);
  const claudeCodeInspection = inspectMcpConfigPath(claudeCodeConfigPath);
  const shellKeyState = buildShellKeyState(deps.env);
  const configKeyState = buildConfigKeyState(claudeInspection.envKeys, "Claude Desktop");
  const codeConfigKeyState = buildConfigKeyState(claudeCodeInspection.envKeys, "Claude Code");
  const suggestions = dedupeStrings([
    ...health.suggestions,
    ...doctorSetupSuggestions(claudeDesktop, claudeInspection, "Claude Desktop"),
    ...doctorSetupSuggestions(claudeCode, claudeCodeInspection, "Claude Code"),
  ]);

  const lines: string[] = [];
  lines.push(`${deps.packageMeta.name} doctor (v${deps.packageMeta.version})`);
  lines.push("");
  lines.push(`Overall: ${health.overallStatus.toUpperCase()}`);
  lines.push(`CLI path: ${deps.cliPath}`);
  lines.push(`Node: ${health.runtime.nodeVersion}`);
  lines.push(`Data dir: ${health.dataDir}`);
  lines.push("");
  lines.push("Checks:");
  for (const check of health.checks) {
    lines.push(`- ${statusPrefix(check.status)} ${check.name}: ${check.detail}`);
  }
  lines.push("");
  lines.push("Client registration:");
  lines.push(`- Claude Desktop detected: ${yesNo(Boolean(claudeDesktop?.detected))}`);
  lines.push(`- Claude Desktop config path: ${claudeDesktop?.configPath ?? "unknown"}`);
  lines.push(`- vidlens-mcp in Claude Desktop config: ${describeInspectionStatus(claudeInspection)}`);
  if (claudeInspection.status === "registered") {
    const command = typeof claudeInspection.serverEntry?.command === "string"
      ? claudeInspection.serverEntry.command
      : "unknown";
    const args = Array.isArray(claudeInspection.serverEntry?.args)
      ? (claudeInspection.serverEntry.args as unknown[]).map(String).join(" ")
      : "";
    lines.push(`- Claude Desktop command: ${command}${args ? ` ${args}` : ""}`);
  }
  lines.push(`- Claude Code detected: ${yesNo(Boolean(claudeCode?.detected))}`);
  lines.push(`- Claude Code config path: ${claudeCodeConfigPath}`);
  lines.push(`- vidlens-mcp in Claude Code config: ${describeInspectionStatus(claudeCodeInspection)}`);
  if (claudeCodeInspection.status === "registered") {
    const command = typeof claudeCodeInspection.serverEntry?.command === "string"
      ? claudeCodeInspection.serverEntry.command
      : "unknown";
    const args = Array.isArray(claudeCodeInspection.serverEntry?.args)
      ? (claudeCodeInspection.serverEntry.args as unknown[]).map(String).join(" ")
      : "";
    lines.push(`- Claude Code command: ${command}${args ? ` ${args}` : ""}`);
  }
  lines.push("");
  lines.push("Key presence:");
  lines.push(`- Shell YOUTUBE_API_KEY: ${shellKeyState.youtube}`);
  lines.push(`- Claude Desktop YOUTUBE_API_KEY: ${configKeyState.youtube}`);
  lines.push(`- Claude Code YOUTUBE_API_KEY: ${codeConfigKeyState.youtube}`);
  lines.push(`- Shell GEMINI_API_KEY / GOOGLE_API_KEY: ${shellKeyState.gemini}`);
  lines.push(`- Claude Desktop GEMINI_API_KEY / GOOGLE_API_KEY: ${configKeyState.gemini}`);
  lines.push(`- Claude Code GEMINI_API_KEY / GOOGLE_API_KEY: ${codeConfigKeyState.gemini}`);
  lines.push("");
  lines.push("Key transparency:");
  for (const item of keyTransparencySummary()) {
    lines.push(`- ${item.key}`);
    lines.push(`  unlocks: ${item.unlocks}`);
    lines.push(`  works without it: ${item.notRequiredFor}`);
  }
  lines.push("");
  if (suggestions.length > 0) {
    lines.push("Suggested next steps:");
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
    lines.push("");
  }
  lines.push("Helpful commands:");
  lines.push(`- node ${deps.cliPath} doctor --no-live`);
  lines.push(`- node ${deps.cliPath} setup`);
  lines.push(`- node ${deps.cliPath} version`);

  return `${lines.join("\n")}\n`;
}

function renderSetupReport(parsed: ParsedCliArgs, deps: CliDeps): string {
  const clients = deps.detectClients();
  const autoDetected = dedupeClientIds(
    clients
      .filter((c) => c.detected && c.supportLevel === "supported")
      .map((c) => c.clientId),
  );
  const targetClients = parsed.clientIds.length > 0
    ? dedupeClientIds(parsed.clientIds)
    : autoDetected.length > 0 ? autoDetected : ["claude_desktop" as KnownClientId];
  const dataDir = parsed.dataDir ?? deps.env.VIDLENS_DATA_DIR ?? resolveDefaultDataDir(deps.homeDir, deps.platform);
  const lines: string[] = [];
  const errors: string[] = [];

  const claudeDesktop = clients.find((client) => client.clientId === "claude_desktop");
  const shouldHandleClaudeDesktop = targetClients.includes("claude_desktop");
  if (shouldHandleClaudeDesktop) {
    if (!claudeDesktop?.configPath) {
      errors.push("Claude Desktop config path could not be resolved.");
      lines.push("  \x1b[31m✗\x1b[0m Claude Desktop — config path not found");
    } else {
      const inspection = inspectMcpConfigPath(claudeDesktop.configPath);
      if (inspection.status === "invalid_json") {
        errors.push(`Claude Desktop config is invalid JSON (${claudeDesktop.configPath}).`);
        lines.push(`  \x1b[31m✗\x1b[0m Claude Desktop — invalid JSON in config`);
        lines.push(`    ${inspection.error ?? "Unknown JSON parse error."}`);
      } else {
        const entry = buildServerEntry({
          nodePath: deps.nodePath,
          cliPath: deps.cliPath,
          dataDir,
          youtubeApiKey: parsed.youtubeApiKey ?? deps.env.YOUTUBE_API_KEY,
          geminiApiKey: parsed.geminiApiKey ?? deps.env.GEMINI_API_KEY,
          googleApiKey: parsed.googleApiKey ?? deps.env.GOOGLE_API_KEY,
          existingEntry: inspection.serverEntry,
          useNpx: deps.isNpx,
          packageName: deps.packageMeta.name,
        });
        const result = upsertMcpServerConfig({
          configPath: claudeDesktop.configPath,
          entry,
          printOnly: parsed.printOnly,
          now: deps.now(),
        });
        lines.push(`  \x1b[32m✓\x1b[0m Claude Desktop ${parsed.printOnly ? "(dry run)" : "configured"}`);
        const ytKey = entry.env?.YOUTUBE_API_KEY ? "\x1b[32m✓\x1b[0m" : "\x1b[90m-\x1b[0m";
        const gemKey = entry.env?.GEMINI_API_KEY || entry.env?.GOOGLE_API_KEY ? "\x1b[32m✓\x1b[0m" : "\x1b[90m-\x1b[0m";
        lines.push(`    Keys: YOUTUBE_API_KEY ${ytKey}  GEMINI_API_KEY ${gemKey}`);
        if (!parsed.printOnly) {
          lines.push("");
          lines.push("  \x1b[1mNext:\x1b[0m fully quit and reopen Claude Desktop.");
        }
      }
    }
    lines.push("");
  }

  const shouldHandleClaudeCode = targetClients.includes("claude_code");
  if (shouldHandleClaudeCode) {
    const claudeCodeConfigPath = resolveClaudeCodeUserConfigPath(deps.homeDir);
    const inspection = inspectMcpConfigPath(claudeCodeConfigPath);
    if (inspection.status === "invalid_json") {
      errors.push(`Claude Code config is invalid JSON (${claudeCodeConfigPath}).`);
      lines.push(`  \x1b[31m✗\x1b[0m Claude Code — invalid JSON in config`);
      lines.push(`    ${inspection.error ?? "Unknown JSON parse error."}`);
    } else {
      const entry = buildServerEntry({
        nodePath: deps.nodePath,
        cliPath: deps.cliPath,
        dataDir,
        youtubeApiKey: parsed.youtubeApiKey ?? deps.env.YOUTUBE_API_KEY,
        geminiApiKey: parsed.geminiApiKey ?? deps.env.GEMINI_API_KEY,
        googleApiKey: parsed.googleApiKey ?? deps.env.GOOGLE_API_KEY,
        existingEntry: inspection.serverEntry,
        useNpx: deps.isNpx,
        packageName: deps.packageMeta.name,
      });
      const result = upsertMcpServerConfig({
        configPath: claudeCodeConfigPath,
        entry,
        printOnly: parsed.printOnly,
        now: deps.now(),
      });
      lines.push(`  \x1b[32m✓\x1b[0m Claude Code ${parsed.printOnly ? "(dry run)" : "configured"}`);
      const ytKey = entry.env?.YOUTUBE_API_KEY ? "\x1b[32m✓\x1b[0m" : "\x1b[90m-\x1b[0m";
      const gemKey = entry.env?.GEMINI_API_KEY || entry.env?.GOOGLE_API_KEY ? "\x1b[32m✓\x1b[0m" : "\x1b[90m-\x1b[0m";
      lines.push(`    Keys: YOUTUBE_API_KEY ${ytKey}  GEMINI_API_KEY ${gemKey}`);
      lines.push(`    Config: ${claudeCodeConfigPath}`);
      if (!parsed.printOnly) {
        lines.push("");
        lines.push("  \x1b[1mNext:\x1b[0m Claude Code picks up changes automatically.");
      }
    }
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push("  Run with --print-only to see the generated config without writing files.");
    const rerunCmd = findGlobalBinary(deps.packageMeta.name) ? "vidlens-mcp setup" : "npx vidlens-mcp setup";
    lines.push(`  Fix any config issues, then rerun: ${rerunCmd}`);
    lines.push("");
  }

  // Startup speed tip if still using npx
  const entry = buildServerEntry({
    nodePath: deps.nodePath,
    cliPath: deps.cliPath,
    dataDir,
    useNpx: deps.isNpx,
    packageName: deps.packageMeta.name,
  });
  if (entry.command === "npx") {
    lines.push("  \x1b[33m⚡ Tip:\x1b[0m Run \x1b[1mnpm install -g vidlens-mcp\x1b[0m for faster Claude Desktop startup (<0.5s vs 1-30s).");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderHelp(packageName: string): string {
  return `${packageName} CLI

Usage:
  vidlens-mcp                 Start the MCP server over stdio
  vidlens-mcp serve           Start the MCP server over stdio
  vidlens-mcp version         Print package version
  vidlens-mcp doctor          Run setup/health diagnostics
  vidlens-mcp setup           Configure detected MCP clients (Claude Desktop, Claude Code)

Common flags:
  --client <id>              Target client (claude_desktop, claude_code, cursor, vscode, codex)
  --data-dir <path>          Override VIDLENS_DATA_DIR for generated config
  --youtube-api-key <key>    Persist YOUTUBE_API_KEY into generated client config
  --gemini-api-key <key>     Persist GEMINI_API_KEY into generated client config
  --google-api-key <key>     Persist GOOGLE_API_KEY into generated client config
  --no-live                  Doctor: skip live network validation probes
  --print-only               Setup: print generated config without writing files
  -h, --help                 Show this help
`;
}

function buildShellKeyState(env: NodeJS.ProcessEnv): { youtube: string; gemini: string } {
  return {
    youtube: env.YOUTUBE_API_KEY ? "set in current shell" : "not set in current shell",
    gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY
      ? "set in current shell"
      : "not set in current shell",
  };
}

function buildConfigKeyState(envKeys: string[], clientLabel = "Claude Desktop"): { youtube: string; gemini: string } {
  return {
    youtube: envKeys.includes("YOUTUBE_API_KEY") ? `present in ${clientLabel} config` : `not present in ${clientLabel} config`,
    gemini: envKeys.includes("GEMINI_API_KEY") || envKeys.includes("GOOGLE_API_KEY")
      ? `present in ${clientLabel} config`
      : `not present in ${clientLabel} config`,
  };
}

function doctorSetupSuggestions(
  client: ClientDetectionSummary | undefined,
  inspection: McpConfigInspection,
  clientLabel = "Claude Desktop",
): string[] {
  const suggestions: string[] = [];
  if (client?.configPath && inspection.status === "not_found") {
    suggestions.push(`Run setup to create ${inspection.path ?? client.configPath} and register vidlens-mcp for ${clientLabel}.`);
  }
  if (inspection.status === "missing") {
    suggestions.push(`Run setup to add vidlens-mcp to ${clientLabel} without disturbing other MCP servers.`);
  }
  if (inspection.status === "invalid_json") {
    suggestions.push(`Fix the invalid ${clientLabel} config JSON at ${inspection.path ?? client?.configPath ?? "the detected config path"}, then rerun setup.`);
  }
  if (inspection.status === "registered" && clientLabel === "Claude Desktop") {
    suggestions.push("Restart Claude Desktop after any setup changes so the updated MCP server registration is reloaded.");
  }
  return suggestions;
}

function describeSetupResult(result: UpsertConfigResult, alreadyRegistered: boolean): string {
  if (result.changed && result.created) {
    return result.path.endsWith(".json") ? "created config and registered vidlens-mcp" : "created target and registered vidlens-mcp";
  }
  if (result.changed && alreadyRegistered) {
    return "updated existing vidlens-mcp entry in-place";
  }
  if (result.changed) {
    return "merged vidlens-mcp into existing MCP config";
  }
  return "already configured; no file changes were needed";
}

function describeInspectionStatus(inspection: McpConfigInspection): string {
  switch (inspection.status) {
    case "registered":
      return "registered";
    case "missing":
      return "config exists, but vidlens-mcp is not registered";
    case "invalid_json":
      return `invalid JSON (${inspection.error ?? "unknown parse error"})`;
    case "not_found":
      return "config file not found";
    default:
      return inspection.status;
  }
}

function parseClientId(raw: string): KnownClientId {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "claude":
    case "claude_desktop":
    case "claude-desktop":
      return "claude_desktop";
    case "chatgpt":
    case "chatgpt_desktop":
    case "chatgpt-desktop":
    case "ultra":
      return "chatgpt_desktop";
    case "claude_code":
    case "claude-code":
      return "claude_code";
    case "cursor":
      return "cursor";
    case "vscode":
    case "vs-code":
    case "code":
      return "vscode";
    case "codex":
      return "codex";
    default:
      throw new CliUserError(`Unknown client id: ${raw}`);
  }
}

function parseConfigRoot(existingText: string | undefined): JsonObject {
  if (!existingText?.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch (error) {
    throw new CliUserError(`Config file is not valid JSON: ${toMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new CliUserError("Config file must contain a JSON object at the root.");
  }

  return { ...parsed };
}

function stringifyEnv(env: JsonObject): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function redactEntryForDisplay(entry: McpServerEntry): McpServerEntry {
  const redactedEnv = entry.env
    ? Object.fromEntries(
        Object.entries(entry.env).map(([key, value]) => {
          if (["YOUTUBE_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].includes(key) && value) {
            return [key, "<set>"];
          }
          return [key, value];
        }),
      )
    : undefined;

  return {
    ...entry,
    env: redactedEnv,
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeClientIds(values: KnownClientId[]): KnownClientId[] {
  return [...new Set(values)];
}

function statusPrefix(status: string): string {
  switch (status) {
    case "ok":
      return "[ok]";
    case "warn":
      return "[warn]";
    case "error":
      return "[error]";
    case "skipped":
      return "[skip]";
    default:
      return `[${status}]`;
  }
}

function requireValue(value: string | undefined, flagName: string): string {
  if (!value) {
    throw new CliUserError(`${flagName} requires a value`);
  }
  return value;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function isNpxInvocation(env: NodeJS.ProcessEnv, cliPath: string): boolean {
  if (env.npm_command === "exec") return true;
  if (cliPath.includes("/_npx/")) return true;
  return false;
}

/** Try to find a globally-installed binary for the given package name. */
function findGlobalBinary(packageName: string): string | null {
  const candidates = [
    join(homedir(), ".npm-global", "bin", packageName),
    `/usr/local/bin/${packageName}`,
    `/opt/homebrew/bin/${packageName}`,
  ];
  // Also check npm global prefix from env
  const npmPrefix = process.env.npm_config_prefix;
  if (npmPrefix) {
    candidates.unshift(join(npmPrefix, "bin", packageName));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Suppress the node:sqlite ExperimentalWarning in MCP serve mode (stderr noise). */
function suppressExperimentalWarnings(): void {
  const orig = process.emitWarning;
  process.emitWarning = ((warning: string | Error, nameOrOptions?: string | { type?: string }, ...rest: unknown[]) => {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions?.type;
    if (name === "ExperimentalWarning") return;
    return (orig as Function).call(process, warning, nameOrOptions, ...rest);
  }) as typeof process.emitWarning;
}

function defaultPromptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
