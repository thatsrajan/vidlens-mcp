import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

export type KnownClientId =
  | "claude_desktop"
  | "claude_code"
  | "cursor"
  | "vscode"
  | "chatgpt_desktop"
  | "codex";

export interface ClientDetectionSummary {
  clientId: KnownClientId;
  name: string;
  detected: boolean;
  supportLevel: "supported" | "scaffolded" | "future";
  installSurface: "config_file" | "binary" | "app_bundle" | "mixed" | "unknown";
  configPath?: string;
  binary?: string;
  notes?: string[];
}

export interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
}

export interface DetectClientsOptions {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function detectKnownClients(options: DetectClientsOptions = {}): ClientDetectionSummary[] {
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  const claudeDesktopConfig = resolveClaudeDesktopConfigPath(homeDir, platform, env);
  const claudeDesktopApp = platform === "darwin" ? "/Applications/Claude.app" : undefined;
  const claudeDesktopDetected = pathExists(claudeDesktopConfig) || pathExists(claudeDesktopApp);

  const claudeCodeUserConfig = resolveClaudeCodeUserConfigPath(homeDir);
  const claudeCodeProjectConfig = resolveClaudeCodeProjectConfigPath(cwd);
  const claudeBinary = commandOnPath("claude", env, platform);
  const claudeCodeDetected = Boolean(claudeBinary || pathExists(claudeCodeUserConfig) || pathExists(claudeCodeProjectConfig));

  const cursorApp = platform === "darwin" ? "/Applications/Cursor.app" : undefined;
  const cursorUserConfig = resolveCursorConfigPath(homeDir, platform, env);
  const cursorDetected = pathExists(cursorApp) || pathExists(cursorUserConfig);

  const vscodeApp = platform === "darwin" ? "/Applications/Visual Studio Code.app" : undefined;
  const vscodeUserConfig = resolveVsCodeConfigPath(homeDir, platform, env);
  const vscodeDetected = pathExists(vscodeApp) || pathExists(vscodeUserConfig);

  const chatgptDesktopApp = platform === "darwin" ? "/Applications/ChatGPT.app" : undefined;
  const chatgptSupportPaths = resolveChatGptDesktopSupportPaths(homeDir, platform, env);
  const discoveredChatGptPaths = chatgptSupportPaths.filter((candidate) => pathExists(candidate));
  const chatgptDesktopDetected = pathExists(chatgptDesktopApp) || discoveredChatGptPaths.length > 0;

  const codexBinary = commandOnPath("codex", env, platform);
  const codexDetected = Boolean(codexBinary);

  return [
    {
      clientId: "claude_desktop",
      name: "Claude Desktop",
      detected: claudeDesktopDetected,
      supportLevel: "supported",
      installSurface: "config_file",
      configPath: claudeDesktopConfig,
      notes: [
        pathExists(claudeDesktopConfig)
          ? "Existing config file detected."
          : "Config file not detected yet; setup can target this path.",
        claudeDesktopApp && pathExists(claudeDesktopApp)
          ? `App bundle detected (${basename(claudeDesktopApp)}).`
          : "App bundle not detected on default path.",
      ],
    },
    {
      clientId: "claude_code",
      name: "Claude Code",
      detected: claudeCodeDetected,
      supportLevel: "supported",
      installSurface: "mixed",
      configPath: pathExists(claudeCodeProjectConfig) ? claudeCodeProjectConfig : claudeCodeUserConfig,
      binary: claudeBinary,
      notes: [
        claudeBinary ? `CLI detected on PATH (${claudeBinary}).` : "CLI not detected on PATH.",
        pathExists(claudeCodeProjectConfig)
          ? `Project MCP config detected (${claudeCodeProjectConfig}).`
          : pathExists(claudeCodeUserConfig)
            ? `User config detected (${claudeCodeUserConfig}).`
            : "No Claude Code config file detected yet.",
      ],
    },
    {
      clientId: "cursor",
      name: "Cursor",
      detected: cursorDetected,
      supportLevel: "scaffolded",
      installSurface: "config_file",
      configPath: cursorUserConfig,
      notes: [
        "Detection only — auto-config is not yet implemented.",
        pathExists(cursorUserConfig)
          ? "Cursor user config path exists."
          : "Cursor user config path not detected.",
      ],
    },
    {
      clientId: "vscode",
      name: "VS Code",
      detected: vscodeDetected,
      supportLevel: "scaffolded",
      installSurface: "config_file",
      configPath: vscodeUserConfig,
      notes: [
        "Detection only — auto-config is not yet implemented.",
        pathExists(vscodeUserConfig)
          ? "VS Code user config path exists."
          : "VS Code user config path not detected.",
      ],
    },
    {
      clientId: "chatgpt_desktop",
      name: "ChatGPT Desktop",
      detected: chatgptDesktopDetected,
      supportLevel: "scaffolded",
      installSurface: "mixed",
      configPath: discoveredChatGptPaths[0] ?? chatgptSupportPaths[0],
      notes: [
        chatgptDesktopDetected
          ? "ChatGPT Desktop support files were detected, but config auto-management is not yet supported."
          : "ChatGPT Desktop was not detected on the default macOS paths.",
        chatgptDesktopApp && pathExists(chatgptDesktopApp)
          ? `App bundle detected (${basename(chatgptDesktopApp)}).`
          : "App bundle not detected on default path.",
        discoveredChatGptPaths.length > 0
          ? `Detected support path(s): ${discoveredChatGptPaths.join(", ")}`
          : `Known support path candidates: ${chatgptSupportPaths.join(", ")}`,
      ],
    },
    {
      clientId: "codex",
      name: "Codex",
      detected: codexDetected,
      supportLevel: "scaffolded",
      installSurface: "binary",
      binary: codexBinary,
      notes: [
        codexBinary
          ? `CLI detected on PATH (${codexBinary}).`
          : "CLI not detected on PATH.",
        "Codex config/install flow is documented as a target, but not yet auto-configured.",
      ],
    },
  ];
}

export function readPackageMetadata(): PackageMetadata {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      name?: string;
      version?: string;
      description?: string;
    };
    return {
      name: packageJson.name ?? "vidlens-mcp",
      version: packageJson.version ?? "0.0.0",
      description: packageJson.description,
    };
  } catch {
    return {
      name: "vidlens-mcp",
      version: "0.0.0",
    };
  }
}

export function keyTransparencySummary(): Array<{ key: string; unlocks: string; notRequiredFor: string }> {
  return [
    {
      key: "YOUTUBE_API_KEY",
      unlocks: "Higher-fidelity metadata, search via API, subscriber counts, comment API access where available.",
      notRequiredFor: "Transcript import/search, playlist expansion, local knowledge-base operations, yt-dlp/page-extract fallback flows.",
    },
    {
      key: "GEMINI_API_KEY / GOOGLE_API_KEY",
      unlocks: "Higher-quality Gemini embeddings for transcript semantic search.",
      notRequiredFor: "Core transcript retrieval/import, local hybrid search, comments/sentiment, diagnostics, playlist workflows.",
    },
  ];
}

export function resolveDefaultDataDir(homeDir: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "vidlens-mcp");
  }
  if (platform === "win32") {
    return join(homeDir, "AppData", "Roaming", "vidlens-mcp");
  }
  return join(homeDir, ".local", "share", "vidlens-mcp");
}

export function resolveClaudeDesktopConfigPath(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? join(appData, "Claude", "claude_desktop_config.json") : undefined;
  }
  return join(homeDir, ".config", "Claude", "claude_desktop_config.json");
}

export function resolveClaudeCodeUserConfigPath(homeDir: string): string {
  return join(homeDir, ".claude", "settings.json");
}

export function resolveClaudeCodeProjectConfigPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

export function resolveCursorConfigPath(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Cursor", "User", "settings.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? join(appData, "Cursor", "User", "settings.json") : undefined;
  }
  return join(homeDir, ".config", "Cursor", "User", "settings.json");
}

export function resolveVsCodeConfigPath(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? join(appData, "Code", "User", "settings.json") : undefined;
  }
  return join(homeDir, ".config", "Code", "User", "settings.json");
}

export function resolveChatGptDesktopSupportPaths(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    return [
      join(homeDir, "Library", "Application Support", "com.openai.chat"),
      join(homeDir, "Library", "Application Support", "com.openai.atlas"),
      join(homeDir, "Library", "Application Support", "OpenAI"),
    ];
  }
  if (platform === "win32") {
    const appData = env.APPDATA;
    const localAppData = env.LOCALAPPDATA;
    return [
      ...(appData ? [join(appData, "OpenAI")] : []),
      ...(localAppData ? [join(localAppData, "OpenAI"), join(localAppData, "com.openai.chat")] : []),
    ];
  }
  return [
    join(homeDir, ".config", "OpenAI"),
    join(homeDir, ".config", "com.openai.chat"),
  ];
}

function pathExists(path?: string): boolean {
  return Boolean(path && existsSync(path));
}

export function commandOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pathValue = env.PATH;
  if (!pathValue) {
    return undefined;
  }

  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  const candidates = platform === "win32"
    ? [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`), ...extensions.map((extension) => `${command}${extension.toUpperCase()}`)]
    : [command];

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const fullPath = join(directory, candidate);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        continue;
      }
    }
  }

  return undefined;
}
