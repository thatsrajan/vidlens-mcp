import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  commandOnPath,
  detectKnownClients,
  keyTransparencySummary,
  readPackageMetadata,
  resolveClaudeCodeRegistryPath,
  resolveClaudeCodeUserConfigPath,
  resolveCodexConfigPath,
  resolveDefaultDataDir,
  type ClientDetectionSummary,
  type KnownClientId,
} from "./install-diagnostics.js";
import { mergeTomlTables, type TomlValue } from "./toml-writer.js";
import { renderBanner } from "./banner.js";
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

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ParsedCliArgs {
  command: "serve" | "version" | "doctor" | "setup" | "update-deps" | "help";
  clientIds: KnownClientId[];
  noLive: boolean;
  printOnly: boolean;
  advancedSetup?: boolean;
  assumeYes?: boolean;
  platform?: string;
  dataDir?: string;
  youtubeApiKey?: string;
  geminiApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  scrapeCreatorsApiKey?: string;
  braveApiKey?: string;
  serpapiKey?: string;
  webSearchProvider?: string;
  sttProvider?: string;
  sttLanguageHint?: string;
  whisperModelPath?: string;
  cookiesFromBrowser?: string;
  cookiesProfile?: string;
  youtubeCookiesFile?: string;
  xCookiesFile?: string;
  instagramCookiesFile?: string;
  tiktokCookiesFile?: string;
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
  /** Whether stdin is an interactive TTY. Non-interactive runs never auto-consent. */
  interactive: boolean;
  promptLine: (question: string) => Promise<string>;
  runCommand: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => CommandResult;
}

export class CliUserError extends Error {
  /** Marker so callers across module boundaries can print `.message` only. */
  readonly userFacing = true;
  constructor(message: string) {
    super(message);
    this.name = "CliUserError";
  }
}

/** Clients that `setup` can actually configure today. */
const SUPPORTED_SETUP_CLIENTS: KnownClientId[] = ["claude_desktop", "claude_code", "codex"];

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
    case "update-deps":
      resolvedDeps.writeStdout(await renderUpdateDepsReport(parsed, resolvedDeps));
      return 0;
    case "setup": {
      const unsupportedClients = dedupeClientIds(
        parsed.clientIds.filter((id) => !SUPPORTED_SETUP_CLIENTS.includes(id)),
      );
      if (unsupportedClients.length > 0) {
        throw new CliUserError(
          `setup does not yet support: ${unsupportedClients.join(", ")}. ` +
            `Supported clients: ${SUPPORTED_SETUP_CLIENTS.join(", ")}.`,
        );
      }
      resolvedDeps.writeStderr(renderBanner({ version: resolvedDeps.packageMeta.version }));
      const detectedClients = resolvedDeps.detectClients();
      const desktopDetected = detectedClients.some(c => c.clientId === "claude_desktop" && c.detected);
      const codeDetected = detectedClients.some(c => c.clientId === "claude_code" && c.detected);
      if (!desktopDetected) {
        resolvedDeps.writeStderr("  \x1b[33m\u26a0\x1b[0m Claude Desktop not detected\n");
        resolvedDeps.writeStderr("    Install: brew install --cask claude\n\n");
      }
      if (!codeDetected) {
        resolvedDeps.writeStderr("  \x1b[33m\u26a0\x1b[0m Claude Code not detected\n");
        resolvedDeps.writeStderr("    Install: npm install -g @anthropic-ai/claude-code\n\n");
      }
      // ── yt-dlp check ──
      const savedSetupEnv = collectExistingClientEnv(detectedClients, resolvedDeps);
      const setupEnv: NodeJS.ProcessEnv = {
        ...savedSetupEnv,
        ...resolvedDeps.env,
      };
      const dataDir = parsed.dataDir ?? setupEnv.VIDLENS_DATA_DIR ?? resolveDefaultDataDir(resolvedDeps.homeDir, resolvedDeps.platform);
      const { findYtDlpBinary, downloadYtDlp } = await import("./ytdlp-installer.js");
      const ytdlpResolved = findYtDlpBinary(dataDir, resolvedDeps.platform, process.arch, setupEnv);
      if (ytdlpResolved) {
        resolvedDeps.writeStderr(`  \x1b[32m✓\x1b[0m yt-dlp found (${ytdlpResolved.source})\n\n`);
      } else {
        resolvedDeps.writeStderr("  \x1b[33m⚠\x1b[0m yt-dlp not found\n");
        resolvedDeps.writeStderr("    yt-dlp is a free, open-source tool that lets VidLens read YouTube\n");
        resolvedDeps.writeStderr("    videos — transcripts, search results, metadata — without needing\n");
        resolvedDeps.writeStderr("    any API keys. Without it, most tools won't work.\n");
        resolvedDeps.writeStderr("    \x1b[2mhttps://github.com/yt-dlp/yt-dlp\x1b[0m\n\n");
        if (await confirmInstallConsent("    Download it now? (Y/n): ", parsed, resolvedDeps)) {
          resolvedDeps.writeStderr("    Downloading yt-dlp...\n");
          try {
            const binPath = await downloadYtDlp(dataDir, resolvedDeps.platform, process.arch);
            resolvedDeps.writeStderr(`    \x1b[32m✓\x1b[0m Saved to ${binPath}\n`);
          } catch (err) {
            resolvedDeps.writeStderr(`    \x1b[31m✗\x1b[0m Download failed: ${err instanceof Error ? err.message : String(err)}\n`);
            resolvedDeps.writeStderr("    Install manually: https://github.com/yt-dlp/yt-dlp#installation\n");
          }
        }
        resolvedDeps.writeStderr("\n");
      }

      const ffmpegTools = detectFfmpegTools(setupEnv, resolvedDeps.platform);
      if (ffmpegTools.available) {
        resolvedDeps.writeStderr(`  \x1b[32m✓\x1b[0m ffmpeg/ffprobe found\n\n`);
      } else {
        resolvedDeps.writeStderr("  \x1b[33m⚠\x1b[0m ffmpeg/ffprobe not found\n");
        resolvedDeps.writeStderr("    Recommended for Instagram/TikTok/X reels, local video files, STT audio chunking,\n");
        resolvedDeps.writeStderr("    keyframe extraction, and visual indexing. YouTube transcript-only flows can still work.\n");
        resolvedDeps.writeStderr(`    Install: ${ffmpegInstallHint(resolvedDeps.platform)}\n\n`);
      }

      resolvedDeps.writeStderr(setupSection("Capability uplift"));
      resolvedDeps.writeStderr(setupHelp("VidLens starts free: public YouTube transcripts/search/metadata use yt-dlp and do not need API keys."));
      resolvedDeps.writeStderr(setupHelp("More video types need more helpers: social/local video often needs ffmpeg, cookies, STT, and/or web discovery."));
      resolvedDeps.writeStderr(setupHelp("Keys are only stored when you pass them or run --advanced; setup will not pull them from your shell."));
      resolvedDeps.writeStderr(setupItem("YOUTUBE_API_KEY", "Better YouTube metadata, API search, subscriber counts; YouTube basics still work without it."));
      resolvedDeps.writeStderr(setupItem("GEMINI_API_KEY", "Semantic search, visual search, AI frame descriptions, and Gemini STT fallback."));
      resolvedDeps.writeStderr(setupItem("OPENAI_API_KEY", "Speech-to-text fallback for X/Instagram/TikTok, generic URLs, and local video files with no captions."));
      resolvedDeps.writeStderr(setupItem("SCRAPECREATORS_API_KEY", "Direct social search/trending across TikTok, Instagram, Threads, Pinterest, Reddit, and supported ScrapeCreators endpoints."));
      resolvedDeps.writeStderr(setupItem("BRAVE_API_KEY or SERPAPI_KEY", "Structured web discovery for finding X/Instagram/TikTok/generic video URLs by query."));
      resolvedDeps.writeStderr(setupItem("Browser cookies", "Access to logged-in, gated, age-limited, or rate-limited social video URLs."));

      if (parsed.advancedSetup) {
        const hasYoutubeKey = Boolean(parsed.youtubeApiKey || savedSetupEnv.YOUTUBE_API_KEY);
        const hasGeminiKey = Boolean(parsed.geminiApiKey || savedSetupEnv.GEMINI_API_KEY || parsed.googleApiKey || savedSetupEnv.GOOGLE_API_KEY);
        const hasOpenAiKey = Boolean(parsed.openaiApiKey || savedSetupEnv.OPENAI_API_KEY);
        const hasScrapeCreatorsKey = Boolean(parsed.scrapeCreatorsApiKey || savedSetupEnv.SCRAPECREATORS_API_KEY);
        const hasWebSearchChoice = Boolean(
          parsed.braveApiKey || savedSetupEnv.BRAVE_API_KEY ||
          parsed.serpapiKey || savedSetupEnv.SERPAPI_KEY ||
          parsed.webSearchProvider || savedSetupEnv.VIDLENS_WEB_SEARCH_PROVIDER
        );
        if (!hasYoutubeKey || !hasGeminiKey || !hasOpenAiKey || !hasScrapeCreatorsKey || !hasWebSearchChoice) {
          resolvedDeps.writeStderr(setupSection("Optional capabilities"));
          resolvedDeps.writeStderr(setupHelp("Skip anything you do not have. You can rerun setup later."));
        }
        if (!hasYoutubeKey) {
          resolvedDeps.writeStderr(setupItem("YOUTUBE_API_KEY", "Better metadata, API search, subscriber counts."));
          resolvedDeps.writeStderr(setupHelp("Get one free: https://console.cloud.google.com/apis/credentials"));
          const key = await resolvedDeps.promptLine("    Key [Enter to skip]: ");
          if (key) parsed.youtubeApiKey = key;
          resolvedDeps.writeStderr("\n");
        }
        if (!hasGeminiKey) {
          resolvedDeps.writeStderr(setupItem("GEMINI_API_KEY", "Semantic search, visual search, AI descriptions, Gemini STT."));
          resolvedDeps.writeStderr(setupHelp("Get one free: https://aistudio.google.com/apikey"));
          const key = await resolvedDeps.promptLine("    Key [Enter to skip]: ");
          if (key) parsed.geminiApiKey = key;
          resolvedDeps.writeStderr("\n");
        }
        if (!hasOpenAiKey) {
          resolvedDeps.writeStderr(setupItem("OPENAI_API_KEY", "OpenAI speech-to-text fallback for social, generic, and local videos."));
          resolvedDeps.writeStderr(setupHelp("Get one: https://platform.openai.com/api-keys"));
          const key = await resolvedDeps.promptLine("    Key [Enter to skip]: ");
          if (key) parsed.openaiApiKey = key;
          resolvedDeps.writeStderr("\n");
        }
        if (!hasScrapeCreatorsKey) {
          resolvedDeps.writeStderr(setupItem("SCRAPECREATORS_API_KEY", "ScrapeCreators social search/trending for TikTok, Instagram, Threads, Pinterest, Reddit, and supported platforms."));
          resolvedDeps.writeStderr(setupHelp("Get one: https://app.scrapecreators.com"));
          const key = await resolvedDeps.promptLine("    Key [Enter to skip]: ");
          if (key) parsed.scrapeCreatorsApiKey = key;
          resolvedDeps.writeStderr("\n");
        }
        if (!hasWebSearchChoice) {
          resolvedDeps.writeStderr(setupItem("Web search discovery", "Finds X/Instagram/TikTok URLs by query."));
          resolvedDeps.writeStderr(setupHelp("Recommended: paste BRAVE_API_KEY if you have one; otherwise press Enter."));
          const brave = await resolvedDeps.promptLine("    BRAVE_API_KEY [Enter to skip]: ");
          if (brave) {
            parsed.braveApiKey = brave;
          } else {
            const serp = await resolvedDeps.promptLine("    SERPAPI_KEY [Enter to skip]: ");
            if (serp) parsed.serpapiKey = serp;
          }
          resolvedDeps.writeStderr("\n");
        }

        resolvedDeps.writeStderr(setupSection("Speech-to-text"));
        resolvedDeps.writeStderr(setupHelp("Used when social/local videos have no captions."));
        resolvedDeps.writeStderr(setupHelp("Recommended: press Enter for auto."));
        resolvedDeps.writeStderr(setupHelp("Auto order: local whisper.cpp -> Gemini -> OpenAI -> none."));
        if (!parsed.sttProvider && !savedSetupEnv.VIDLENS_STT_PROVIDER) {
          const provider = await resolvedDeps.promptLine("    Provider [auto]: ");
          if (provider) parsed.sttProvider = provider;
        }
        if (!parsed.sttLanguageHint && !savedSetupEnv.VIDLENS_STT_LANGUAGE_HINT) {
          const language = await resolvedDeps.promptLine("    Language hint [en or Enter]: ");
          if (language) parsed.sttLanguageHint = language;
        }
        if (!parsed.whisperModelPath && !savedSetupEnv.VIDLENS_WHISPER_MODEL_PATH) {
          const modelPath = await resolvedDeps.promptLine("    whisper.cpp model path [Enter to skip]: ");
          if (modelPath) parsed.whisperModelPath = modelPath;
        }
        const { selectSttProvider } = await import("./stt/selector.js");
        const sttSelection = selectSttProvider(
          buildSetupRuntimeEnv(parsed, savedSetupEnv),
          parsed.sttProvider as "auto" | "whisper-cpp" | "gemini" | "openai" | "none" | undefined,
        );
        resolvedDeps.writeStderr(setupDetected("STT", sttSelection.providerId, sttSelection.details.join(" ")));

        resolvedDeps.writeStderr(setupSection("Web search"));
        resolvedDeps.writeStderr(setupHelp("Used by searchVideoSources to discover social/generic video URLs by query."));
        resolvedDeps.writeStderr(setupHelp("Recommended: press Enter for auto."));
        resolvedDeps.writeStderr(setupHelp("Auto order: Brave -> SerpAPI -> DuckDuckGo-lite."));
        if (!parsed.webSearchProvider && !savedSetupEnv.VIDLENS_WEB_SEARCH_PROVIDER) {
          const provider = await resolvedDeps.promptLine("    Provider [auto]: ");
          if (provider) parsed.webSearchProvider = provider;
        }
        const { selectWebSearchProvider } = await import("./web-search/selector.js");
        const webSelection = selectWebSearchProvider(buildSetupRuntimeEnv(parsed, savedSetupEnv));
        resolvedDeps.writeStderr(setupDetected("Web search", webSelection.providerId, webSelection.details.join(" ")));

        const hasCookieSetting = Boolean(
          parsed.cookiesFromBrowser || savedSetupEnv.VIDLENS_COOKIES_FROM_BROWSER ||
          parsed.youtubeCookiesFile || savedSetupEnv.VIDLENS_YOUTUBE_COOKIES_FILE ||
          parsed.xCookiesFile || savedSetupEnv.VIDLENS_X_COOKIES_FILE ||
          parsed.instagramCookiesFile || savedSetupEnv.VIDLENS_INSTAGRAM_COOKIES_FILE ||
          parsed.tiktokCookiesFile || savedSetupEnv.VIDLENS_TIKTOK_COOKIES_FILE
        );
        if (!hasCookieSetting) {
          resolvedDeps.writeStderr(setupSection("Cookies"));
          resolvedDeps.writeStderr(setupHelp("Used for rate-limited or gated social videos. Cookie contents are never printed."));
          resolvedDeps.writeStderr(setupHelp("Recommended: enter the browser where you are logged into X/Instagram/TikTok."));
          const browser = await resolvedDeps.promptLine("    Browser [chrome/safari/firefox/edge/brave/opera/chromium/vivaldi or Enter]: ");
          if (browser) {
            const normalizedBrowser = normalizeBrowserCookieSource(browser);
            if (normalizedBrowser) {
              parsed.cookiesFromBrowser = normalizedBrowser;
              resolvedDeps.writeStderr(setupDetected("Cookies", `browser:${normalizedBrowser}`, "yt-dlp reads cookies during import, not during setup."));
              const profile = await resolvedDeps.promptLine("    Profile folder [Enter for default; examples: Default, Profile 1; not your email]: ");
              if (profile && looksLikeEmail(profile)) {
                resolvedDeps.writeStderr(setupWarn("That looks like an email address. Skipping profile; use Default or Profile 1 if needed."));
              } else if (profile) {
                parsed.cookiesProfile = profile;
              }
            } else {
              resolvedDeps.writeStderr(setupWarn(`Unsupported browser "${browser.trim()}"; skipping browser cookies.`));
            }
          } else {
            resolvedDeps.writeStderr(setupWarn("Cookie source skipped. Public videos still work; gated/rate-limited social URLs may need cookies later."));
          }
          resolvedDeps.writeStderr(setupHelp("Platform cookie files are only for exported Netscape-format .txt files."));
          const platformFiles = await resolvedDeps.promptLine("    Add platform cookie files? [y/N]: ");
          if (platformFiles.trim().toLowerCase() === "y") {
            const youtube = await resolvedDeps.promptLine("      YouTube cookies file [Enter to skip]: ");
            if (youtube) parsed.youtubeCookiesFile = youtube;
            const x = await resolvedDeps.promptLine("      X/Twitter cookies file [Enter to skip]: ");
            if (x) parsed.xCookiesFile = x;
            const instagram = await resolvedDeps.promptLine("      Instagram cookies file [Enter to skip]: ");
            if (instagram) parsed.instagramCookiesFile = instagram;
            const tiktok = await resolvedDeps.promptLine("      TikTok cookies file [Enter to skip]: ");
            if (tiktok) parsed.tiktokCookiesFile = tiktok;
          }
        }
        resolvedDeps.writeStderr("\n");
      } else {
        resolvedDeps.writeStderr(setupHelp("Continuing with free core setup. Use --advanced to add capability-uplift keys/cookies now."));
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
          if (await confirmInstallConsent("    Install globally now? (Y/n): ", parsed, resolvedDeps)) {
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
    if (["serve", "version", "doctor", "setup", "update-deps", "help"].includes(first)) {
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

    if (token.startsWith("--platform=")) {
      parsed.platform = token.slice("--platform=".length);
      continue;
    }

    if (token === "--platform") {
      parsed.platform = requireValue(args.shift(), "--platform");
      continue;
    }

    if (token === "--print-only" || token === "--dry-run") {
      parsed.printOnly = true;
      continue;
    }

    if (token === "--advanced" || token === "--advanced-setup" || token === "--configure-optional") {
      parsed.advancedSetup = true;
      continue;
    }

    if (token === "--yes" || token === "-y") {
      parsed.assumeYes = true;
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

    if (token.startsWith("--openai-api-key=")) {
      parsed.openaiApiKey = token.slice("--openai-api-key=".length);
      continue;
    }

    if (token === "--openai-api-key") {
      parsed.openaiApiKey = requireValue(args.shift(), "--openai-api-key");
      continue;
    }

    if (token.startsWith("--scrapecreators-api-key=")) {
      parsed.scrapeCreatorsApiKey = token.slice("--scrapecreators-api-key=".length);
      continue;
    }

    if (token === "--scrapecreators-api-key") {
      parsed.scrapeCreatorsApiKey = requireValue(args.shift(), "--scrapecreators-api-key");
      continue;
    }

    if (token.startsWith("--brave-api-key=")) {
      parsed.braveApiKey = token.slice("--brave-api-key=".length);
      continue;
    }

    if (token === "--brave-api-key") {
      parsed.braveApiKey = requireValue(args.shift(), "--brave-api-key");
      continue;
    }

    if (token.startsWith("--serpapi-key=")) {
      parsed.serpapiKey = token.slice("--serpapi-key=".length);
      continue;
    }

    if (token === "--serpapi-key") {
      parsed.serpapiKey = requireValue(args.shift(), "--serpapi-key");
      continue;
    }

    if (token.startsWith("--web-search-provider=")) {
      parsed.webSearchProvider = token.slice("--web-search-provider=".length);
      continue;
    }

    if (token === "--web-search-provider") {
      parsed.webSearchProvider = requireValue(args.shift(), "--web-search-provider");
      continue;
    }

    if (token.startsWith("--stt-provider=")) {
      parsed.sttProvider = token.slice("--stt-provider=".length);
      continue;
    }

    if (token === "--stt-provider") {
      parsed.sttProvider = requireValue(args.shift(), "--stt-provider");
      continue;
    }

    if (token.startsWith("--stt-language-hint=")) {
      parsed.sttLanguageHint = token.slice("--stt-language-hint=".length);
      continue;
    }

    if (token === "--stt-language-hint") {
      parsed.sttLanguageHint = requireValue(args.shift(), "--stt-language-hint");
      continue;
    }

    if (token.startsWith("--whisper-model-path=")) {
      parsed.whisperModelPath = token.slice("--whisper-model-path=".length);
      continue;
    }

    if (token === "--whisper-model-path") {
      parsed.whisperModelPath = requireValue(args.shift(), "--whisper-model-path");
      continue;
    }

    if (token.startsWith("--cookies-from-browser=")) {
      parsed.cookiesFromBrowser = token.slice("--cookies-from-browser=".length);
      continue;
    }

    if (token === "--cookies-from-browser") {
      parsed.cookiesFromBrowser = requireValue(args.shift(), "--cookies-from-browser");
      continue;
    }

    if (token.startsWith("--cookies-profile=")) {
      parsed.cookiesProfile = token.slice("--cookies-profile=".length);
      continue;
    }

    if (token === "--cookies-profile") {
      parsed.cookiesProfile = requireValue(args.shift(), "--cookies-profile");
      continue;
    }

    if (token.startsWith("--youtube-cookies-file=")) {
      parsed.youtubeCookiesFile = token.slice("--youtube-cookies-file=".length);
      continue;
    }

    if (token === "--youtube-cookies-file") {
      parsed.youtubeCookiesFile = requireValue(args.shift(), "--youtube-cookies-file");
      continue;
    }

    if (token.startsWith("--x-cookies-file=")) {
      parsed.xCookiesFile = token.slice("--x-cookies-file=".length);
      continue;
    }

    if (token === "--x-cookies-file") {
      parsed.xCookiesFile = requireValue(args.shift(), "--x-cookies-file");
      continue;
    }

    if (token.startsWith("--instagram-cookies-file=")) {
      parsed.instagramCookiesFile = token.slice("--instagram-cookies-file=".length);
      continue;
    }

    if (token === "--instagram-cookies-file") {
      parsed.instagramCookiesFile = requireValue(args.shift(), "--instagram-cookies-file");
      continue;
    }

    if (token.startsWith("--tiktok-cookies-file=")) {
      parsed.tiktokCookiesFile = token.slice("--tiktok-cookies-file=".length);
      continue;
    }

    if (token === "--tiktok-cookies-file") {
      parsed.tiktokCookiesFile = requireValue(args.shift(), "--tiktok-cookies-file");
      continue;
    }

    throw new CliUserError(`Unknown flag: ${token}`);
  }

  return parsed;
}

export function buildServerEntry(options: {
  nodePath: string;
  cliPath: string;
  /** Fallback data dir (process env → platform default) when neither a flag nor a saved value applies. */
  dataDir: string;
  /** Explicit `--data-dir` flag value; wins over any previously saved config value. */
  explicitDataDir?: string;
  youtubeApiKey?: string;
  geminiApiKey?: string;
  googleApiKey?: string;
  existingEntry?: JsonObject;
  useNpx?: boolean;
  packageName?: string;
  extraEnv?: Record<string, string | undefined>;
}): McpServerEntry {
  const existingEnv = isRecord(options.existingEntry?.env)
    ? stringifyEnv(options.existingEntry.env)
    : {};
  // Precedence: explicit --data-dir flag > value already saved in the client
  // config > process env / platform default. Preserves a user's custom
  // VIDLENS_DATA_DIR across re-runs of `setup` without --data-dir (WS2-2).
  const savedDataDir = existingEnv.VIDLENS_DATA_DIR;
  const env: Record<string, string> = {
    ...existingEnv,
    VIDLENS_DATA_DIR: options.explicitDataDir ?? savedDataDir ?? options.dataDir,
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
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (typeof value === "string" && value.trim()) {
      env[key] = value.trim();
    }
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

function buildSetupExtraEnv(parsed: ParsedCliArgs): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: parsed.openaiApiKey,
    SCRAPECREATORS_API_KEY: parsed.scrapeCreatorsApiKey,
    BRAVE_API_KEY: parsed.braveApiKey,
    SERPAPI_KEY: parsed.serpapiKey,
    VIDLENS_WEB_SEARCH_PROVIDER: parsed.webSearchProvider,
    VIDLENS_STT_PROVIDER: parsed.sttProvider,
    VIDLENS_STT_LANGUAGE_HINT: parsed.sttLanguageHint,
    VIDLENS_WHISPER_MODEL_PATH: parsed.whisperModelPath,
    VIDLENS_COOKIES_FROM_BROWSER: parsed.cookiesFromBrowser,
    VIDLENS_COOKIES_PROFILE: parsed.cookiesProfile,
    VIDLENS_YOUTUBE_COOKIES_FILE: parsed.youtubeCookiesFile,
    VIDLENS_X_COOKIES_FILE: parsed.xCookiesFile,
    VIDLENS_INSTAGRAM_COOKIES_FILE: parsed.instagramCookiesFile,
    VIDLENS_TIKTOK_COOKIES_FILE: parsed.tiktokCookiesFile,
  };
}

function buildSetupRuntimeEnv(parsed: ParsedCliArgs, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtimeEnv: NodeJS.ProcessEnv = { ...env };
  const values: Record<string, string | undefined> = {
    YOUTUBE_API_KEY: parsed.youtubeApiKey,
    GEMINI_API_KEY: parsed.geminiApiKey,
    GOOGLE_API_KEY: parsed.googleApiKey,
    ...buildSetupExtraEnv(parsed),
  };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.trim()) {
      runtimeEnv[key] = value.trim();
    }
  }
  return runtimeEnv;
}

function collectExistingClientEnv(clients: ClientDetectionSummary[], deps: CliDeps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const claudeDesktop = clients.find((client) => client.clientId === "claude_desktop");
  mergeEnvFromMcpInspection(env, inspectMcpConfigPath(claudeDesktop?.configPath));
  mergeEnvFromMcpInspection(env, inspectMcpConfigPath(resolveClaudeCodeRegistryPath(deps.homeDir)));
  const codex = clients.find((client) => client.clientId === "codex");
  mergeEnvFromCodexConfig(env, codex?.configPath ?? resolveCodexConfigPath(deps.homeDir));
  return env;
}

function mergeEnvFromMcpInspection(target: NodeJS.ProcessEnv, inspection: McpConfigInspection): void {
  if (!inspection.serverEntry || !isRecord(inspection.serverEntry.env)) {
    return;
  }
  for (const [key, value] of Object.entries(inspection.serverEntry.env)) {
    if (typeof value === "string" && value) {
      target[key] = value;
    }
  }
}

function mergeEnvFromCodexConfig(target: NodeJS.ProcessEnv, configPath: string | undefined): void {
  if (!configPath || !existsSync(configPath)) {
    return;
  }
  Object.assign(target, readCodexConfigEnv(readFileSync(configPath, "utf8")));
}

function readCodexConfigEnv(configText: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (!configText) {
    return env;
  }
  let inEnvSection = false;
  for (const line of configText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inEnvSection = trimmed === "[mcp_servers.vidlens-mcp.env]";
      continue;
    }
    if (!inEnvSection) {
      continue;
    }
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*("(?:\\.|[^"])*")\s*$/);
    if (!match) {
      continue;
    }
    try {
      const key = match[1];
      const rawValue = match[2];
      if (key && rawValue) {
        env[key] = JSON.parse(rawValue) as string;
      }
    } catch {
      continue;
    }
  }
  return env;
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

export function inspectCodexConfigPath(configPath: string | undefined): McpConfigInspection {
  if (!configPath || !existsSync(configPath)) {
    return { path: configPath, status: "not_found", envKeys: [] };
  }
  const text = readFileSync(configPath, "utf8");
  return {
    path: configPath,
    status: text.includes("[mcp_servers.vidlens-mcp]") ? "registered" : "missing",
    envKeys: [...text.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((match) => match[1] ?? ""),
  };
}

export function upsertCodexConfig(options: {
  configPath: string;
  existingText?: string;
  entry: McpServerEntry;
  pluginPath: string;
  printOnly?: boolean;
  now?: Date;
}): UpsertConfigResult {
  const nextText = mergeTomlTables(options.existingText, buildCodexTables(options.entry, options.pluginPath));
  const changed = options.existingText !== nextText;
  const created = !options.existingText;

  let backupPath: string | undefined;
  if (!options.printOnly && changed) {
    mkdirSync(dirname(options.configPath), { recursive: true });
    if (options.existingText !== undefined) {
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

function buildCodexTables(entry: McpServerEntry, pluginPath: string): Record<string, Record<string, TomlValue>> {
  const tables: Record<string, Record<string, TomlValue>> = {
    "mcp_servers.vidlens-mcp": {
      command: entry.command,
      args: entry.args,
    },
    "marketplaces.vidlens": {
      source_type: "local",
      source: pluginPath,
    },
    'plugins."vidlens@vidlens"': {
      enabled: true,
    },
  };
  if (entry.env && Object.keys(entry.env).length > 0) {
    tables["mcp_servers.vidlens-mcp.env"] = entry.env;
  }
  return tables;
}

function resolvePluginPath(deps: CliDeps): string {
  const checkoutRoot = dirname(dirname(deps.cliPath));
  const checkoutPlugin = join(checkoutRoot, "plugins", "vidlens");
  if (existsSync(checkoutPlugin)) {
    return checkoutPlugin;
  }
  return join(process.cwd(), "plugins", "vidlens");
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
      const { findYtDlpBinary: findBinary } = await import("./ytdlp-installer.js");
      const h = overrides.homeDir ?? homedir();
      const p = overrides.platform ?? process.platform;
      const dataDir = env.VIDLENS_DATA_DIR || resolveDefaultDataDir(h, p);
      const resolved = findBinary(dataDir, p, process.arch, env);
      return new YouTubeService({ ytDlpBinary: resolved?.path, dataDir });
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
    interactive: overrides.interactive ?? Boolean(process.stdin.isTTY),
    promptLine: overrides.promptLine ?? defaultPromptLine,
    runCommand: overrides.runCommand ?? defaultRunCommand,
  };
}

async function renderDoctorReport(parsed: ParsedCliArgs, deps: CliDeps): Promise<string> {
  const service = await deps.createService();
  const health = await service.checkSystemHealth({ runLiveChecks: !parsed.noLive });
  const clients = deps.detectClients();
  const claudeDesktop = clients.find((client) => client.clientId === "claude_desktop");
  const claudeInspection = inspectMcpConfigPath(claudeDesktop?.configPath);
  const claudeCode = clients.find((client) => client.clientId === "claude_code");
  const claudeCodeConfigPath = resolveClaudeCodeRegistryPath(deps.homeDir);
  const claudeCodeInspection = inspectMcpConfigPath(claudeCodeConfigPath);
  const claudeCodeCliInspection = inspectClaudeCodeCliRegistration(claudeCode?.binary, deps);
  const codex = clients.find((client) => client.clientId === "codex");
  const codexConfigPath = codex?.configPath ?? resolveCodexConfigPath(deps.homeDir);
  const codexInspection = inspectCodexConfigPath(codexConfigPath);
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
  if (health.ytdlp) {
    lines.push(`yt-dlp: ${health.ytdlp.version ?? "unknown"} (${health.ytdlp.freshness ?? "unknown"})`);
  }
  if (health.ffmpeg) {
    lines.push(`ffmpeg: ${health.ffmpeg.available ? health.ffmpeg.ffmpegVersion ?? "available" : "missing"}`);
  }
  if (health.runtime.jsRuntime) {
    lines.push(`JS runtime: ${health.runtime.jsRuntime.runtime} ${health.runtime.jsRuntime.version ?? ""}`.trim());
  }
  lines.push("");
  lines.push("Checks:");
  for (const check of health.checks) {
    lines.push(`- ${statusPrefix(check.status)} ${check.name}: ${check.detail}`);
  }
  lines.push("");
  if (health.platforms?.length) {
    const platforms = parsed.platform
      ? health.platforms.filter((platform) => platform.platform === parsed.platform)
      : health.platforms;
    lines.push("Platform readiness:");
    for (const platform of platforms) {
      lines.push(`- ${platform.platform}: ${platform.status} (${platform.detail})`);
    }
    lines.push("");
  }
  lines.push("Provider readiness:");
  lines.push(`- STT: ${health.stt?.selectedProvider ?? "none"} (${health.stt?.details.join(" ") ?? "not checked"})`);
  lines.push(`- Web search: ${health.webSearch?.selectedProvider ?? "none"} (${health.webSearch?.details.join(" ") ?? "not checked"})`);
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
  lines.push(`- Claude Code CLI registry check: ${describeClaudeCodeCliInspection(claudeCodeCliInspection)}`);
  if (claudeCodeInspection.status === "registered") {
    const command = typeof claudeCodeInspection.serverEntry?.command === "string"
      ? claudeCodeInspection.serverEntry.command
      : "unknown";
    const args = Array.isArray(claudeCodeInspection.serverEntry?.args)
      ? (claudeCodeInspection.serverEntry.args as unknown[]).map(String).join(" ")
      : "";
    lines.push(`- Claude Code command: ${command}${args ? ` ${args}` : ""}`);
  }
  lines.push(`- Codex detected: ${yesNo(Boolean(codex?.detected))}`);
  lines.push(`- Codex config path: ${codexConfigPath}`);
  lines.push(`- vidlens-mcp in Codex config: ${describeInspectionStatus(codexInspection)}`);
  lines.push("");
  lines.push("Key presence:");
  lines.push(`- Shell YOUTUBE_API_KEY: ${shellKeyState.youtube}`);
  lines.push(`- Claude Desktop YOUTUBE_API_KEY: ${configKeyState.youtube}`);
  lines.push(`- Claude Code YOUTUBE_API_KEY: ${codeConfigKeyState.youtube}`);
  lines.push(`- Shell GEMINI_API_KEY / GOOGLE_API_KEY: ${shellKeyState.gemini}`);
  lines.push(`- Claude Desktop GEMINI_API_KEY / GOOGLE_API_KEY: ${configKeyState.gemini}`);
  lines.push(`- Claude Code GEMINI_API_KEY / GOOGLE_API_KEY: ${codeConfigKeyState.gemini}`);
  lines.push(`- Shell OPENAI_API_KEY: ${deps.env.OPENAI_API_KEY ? "set in current shell" : "not set in current shell"}`);
  lines.push(`- Shell SCRAPECREATORS_API_KEY: ${deps.env.SCRAPECREATORS_API_KEY ? "set in current shell" : "not set in current shell"}`);
  lines.push(`- Shell BRAVE_API_KEY: ${deps.env.BRAVE_API_KEY ? "set in current shell" : "not set in current shell"}`);
  lines.push(`- Shell SERPAPI_KEY: ${deps.env.SERPAPI_KEY ? "set in current shell" : "not set in current shell"}`);
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

async function renderUpdateDepsReport(parsed: ParsedCliArgs, deps: CliDeps): Promise<string> {
  const dataDir = parsed.dataDir ?? deps.env.VIDLENS_DATA_DIR ?? resolveDefaultDataDir(deps.homeDir, deps.platform);
  const lines: string[] = [];
  lines.push(`${deps.packageMeta.name} update-deps`);
  lines.push(`Data dir: ${dataDir}`);
  lines.push("");

  try {
    const { downloadYtDlp } = await import("./ytdlp-installer.js");
    const path = await downloadYtDlp(dataDir, deps.platform, process.arch);
    lines.push(`- ok yt-dlp: ${path}`);
  } catch (error) {
    lines.push(`- error yt-dlp: ${toMessage(error)}`);
  }

  try {
    const { ensureDeno } = await import("./diagnostics/deno-installer.js");
    const path = await ensureDeno(dataDir, deps.platform, process.arch);
    lines.push(`- ok deno: ${path}`);
  } catch (error) {
    lines.push(`- warn deno: ${toMessage(error)}`);
  }

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
  // Fallback only: process env → platform default. The explicit flag and any
  // saved config value take precedence inside buildServerEntry (WS2-2).
  const fallbackDataDir = deps.env.VIDLENS_DATA_DIR ?? resolveDefaultDataDir(deps.homeDir, deps.platform);
  const explicitDataDir = parsed.dataDir;
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
          dataDir: fallbackDataDir,
          explicitDataDir,
          youtubeApiKey: parsed.youtubeApiKey,
          geminiApiKey: parsed.geminiApiKey,
          googleApiKey: parsed.googleApiKey,
          existingEntry: inspection.serverEntry,
          useNpx: deps.isNpx,
          packageName: deps.packageMeta.name,
          extraEnv: buildSetupExtraEnv(parsed),
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
        lines.push(`    Universal: ${describeUniversalSetupEnv(entry.env)}`);
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
    const claudeCodeConfigPath = resolveClaudeCodeRegistryPath(deps.homeDir);
    const inspection = inspectMcpConfigPath(claudeCodeConfigPath);
    if (inspection.status === "invalid_json") {
      errors.push(`Claude Code config is invalid JSON (${claudeCodeConfigPath}).`);
      lines.push(`  \x1b[31m✗\x1b[0m Claude Code — invalid JSON in config`);
      lines.push(`    ${inspection.error ?? "Unknown JSON parse error."}`);
    } else {
      const entry = buildServerEntry({
        nodePath: deps.nodePath,
        cliPath: deps.cliPath,
        dataDir: fallbackDataDir,
        explicitDataDir,
        youtubeApiKey: parsed.youtubeApiKey,
        geminiApiKey: parsed.geminiApiKey,
        googleApiKey: parsed.googleApiKey,
        existingEntry: inspection.serverEntry,
        useNpx: deps.isNpx,
        packageName: deps.packageMeta.name,
        extraEnv: buildSetupExtraEnv(parsed),
      });
      const result = upsertClaudeCodeMcpRegistration({
        claudeBinary: clients.find((client) => client.clientId === "claude_code")?.binary,
        configPath: claudeCodeConfigPath,
        entry,
        printOnly: parsed.printOnly,
        now: deps.now(),
        deps,
      });
      lines.push(`  \x1b[32m✓\x1b[0m Claude Code ${parsed.printOnly ? "(dry run)" : "configured"}`);
      const ytKey = entry.env?.YOUTUBE_API_KEY ? "\x1b[32m✓\x1b[0m" : "\x1b[90m-\x1b[0m";
      const gemKey = entry.env?.GEMINI_API_KEY || entry.env?.GOOGLE_API_KEY ? "\x1b[32m✓\x1b[0m" : "\x1b[90m-\x1b[0m";
      lines.push(`    Keys: YOUTUBE_API_KEY ${ytKey}  GEMINI_API_KEY ${gemKey}`);
      lines.push(`    Universal: ${describeUniversalSetupEnv(entry.env)}`);
      lines.push(`    Config: ${claudeCodeConfigPath}`);
      lines.push(`    Method: ${describeClaudeCodeSetupMethod(result)}`);
      if (!parsed.printOnly) {
        lines.push(`    Check: ${describeClaudeCodeCliInspection(result.cliInspection)}`);
      }
      if (!parsed.printOnly) {
        lines.push("");
        lines.push("  \x1b[1mNext:\x1b[0m restart Claude Code or run /mcp in a new session.");
      }
    }
    lines.push("");
  }

  const shouldHandleCodex = targetClients.includes("codex");
  if (shouldHandleCodex) {
    const codexConfigPath = clients.find((client) => client.clientId === "codex")?.configPath ?? resolveCodexConfigPath(deps.homeDir);
    const existingText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : undefined;
    const entry = buildServerEntry({
      nodePath: deps.nodePath,
      cliPath: deps.cliPath,
      dataDir: fallbackDataDir,
      explicitDataDir,
      youtubeApiKey: parsed.youtubeApiKey,
      geminiApiKey: parsed.geminiApiKey,
      googleApiKey: parsed.googleApiKey,
      existingEntry: { env: readCodexConfigEnv(existingText) },
      useNpx: deps.isNpx,
      packageName: deps.packageMeta.name,
      extraEnv: buildSetupExtraEnv(parsed),
    });
    const result = upsertCodexConfig({
      configPath: codexConfigPath,
      existingText,
      entry,
      pluginPath: resolvePluginPath(deps),
      printOnly: parsed.printOnly,
      now: deps.now(),
    });
    lines.push(`  \x1b[32m✓\x1b[0m Codex ${parsed.printOnly ? "(dry run)" : "configured"}`);
    lines.push(`    Config: ${codexConfigPath}`);
    lines.push(`    Universal: ${describeUniversalSetupEnv(entry.env)}`);
    if (parsed.printOnly) {
      lines.push("");
      lines.push(redactSetupConfigForDisplay(result.configText, parsed, deps.env).trimEnd());
    } else {
      lines.push("    MCP server and local plugin marketplace registered.");
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
    dataDir: fallbackDataDir,
    explicitDataDir,
    useNpx: deps.isNpx,
    packageName: deps.packageMeta.name,
    extraEnv: buildSetupExtraEnv(parsed),
  });
  if (entry.command === "npx") {
    lines.push("  \x1b[33m⚡ Tip:\x1b[0m Run \x1b[1mnpm install -g vidlens-mcp\x1b[0m for faster Claude Desktop startup (<0.5s vs 1-30s).");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

interface ClaudeCodeSetupResult extends UpsertConfigResult {
  method: "claude_cli" | "registry_file" | "print_only";
  cliInspection: ClaudeCodeCliInspection;
  note?: string;
}

interface ClaudeCodeCliInspection {
  status: "not_available" | "connected" | "listed" | "not_listed" | "error" | "skipped";
  detail: string;
}

function upsertClaudeCodeMcpRegistration(options: {
  claudeBinary?: string;
  configPath: string;
  entry: McpServerEntry;
  printOnly?: boolean;
  now?: Date;
  deps: CliDeps;
}): ClaudeCodeSetupResult {
  const filePlan = upsertMcpServerConfig({
    configPath: options.configPath,
    entry: options.entry,
    printOnly: true,
    now: options.now,
  });

  if (options.printOnly) {
    return {
      ...filePlan,
      method: "print_only",
      cliInspection: { status: "skipped", detail: "print-only mode; no Claude Code command was run" },
    };
  }

  const claudeBinary = options.claudeBinary ?? commandOnPath("claude", options.deps.env, options.deps.platform);
  const sensitiveEnvReason = describeSensitiveEnvForProcessArgs(options.entry);
  if (claudeBinary && !sensitiveEnvReason) {
    const addResult = options.deps.runCommand(
      claudeBinary,
      ["mcp", "add-json", "--scope", "user", "vidlens-mcp", JSON.stringify(options.entry)],
      { env: options.deps.env, timeoutMs: 20_000 },
    );
    if (addResult.status === 0) {
      return {
        ...filePlan,
        method: "claude_cli",
        cliInspection: inspectClaudeCodeCliRegistration(claudeBinary, options.deps),
      };
    }
  }

  const fileResult = upsertMcpServerConfig({
    configPath: options.configPath,
    entry: options.entry,
    printOnly: false,
    now: options.now,
  });
  return {
    ...fileResult,
    method: "registry_file",
    cliInspection: claudeBinary
      ? inspectClaudeCodeCliRegistration(claudeBinary, options.deps)
      : { status: "not_available", detail: "claude CLI was not found on PATH" },
    note: sensitiveEnvReason ?? (claudeBinary ? "claude mcp add-json was unavailable or failed" : "claude CLI was not found on PATH"),
  };
}

function inspectClaudeCodeCliRegistration(claudeBinary: string | undefined, deps: CliDeps): ClaudeCodeCliInspection {
  const binary = claudeBinary ?? commandOnPath("claude", deps.env, deps.platform);
  if (!binary) {
    return { status: "not_available", detail: "claude CLI was not found on PATH" };
  }

  const result = deps.runCommand(binary, ["mcp", "list"], { env: deps.env, timeoutMs: 20_000 });
  if (result.status !== 0) {
    return { status: "error", detail: "claude mcp list did not complete successfully" };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined.split(/\r?\n/).filter((line) => line.includes("vidlens-mcp"));
  if (lines.length === 0) {
    return { status: "not_listed", detail: "claude mcp list does not show vidlens-mcp" };
  }

  const line = lines[0] ?? "";
  if (line.includes("✓") || /\bConnected\b/i.test(line)) {
    return { status: "connected", detail: "claude mcp list shows vidlens-mcp connected" };
  }
  return { status: "listed", detail: "claude mcp list shows vidlens-mcp" };
}

function describeClaudeCodeSetupMethod(result: ClaudeCodeSetupResult): string {
  switch (result.method) {
    case "claude_cli":
      return "Claude Code CLI registry (claude mcp add-json --scope user)";
    case "registry_file":
      return result.note ? `direct user registry file (${result.note})` : "direct user registry file";
    case "print_only":
      return "dry-run preview only";
    default:
      return result.method;
  }
}

function describeSensitiveEnvForProcessArgs(entry: McpServerEntry): string | undefined {
  const envKeys = Object.keys(entry.env ?? {});
  const sensitiveKeys = envKeys.filter((key) =>
    key.endsWith("_API_KEY") ||
    key.endsWith("_TOKEN") ||
    key.endsWith("_SECRET") ||
    key.includes("COOKIE") ||
    key.includes("COOKIES"),
  );
  return sensitiveKeys.length > 0 ? "keeps API keys and cookie settings out of command arguments" : undefined;
}

function renderHelp(packageName: string): string {
  return `${packageName} CLI

Usage:
  vidlens-mcp                 Start the MCP server over stdio
  vidlens-mcp serve           Start the MCP server over stdio
  vidlens-mcp version         Print package version
  vidlens-mcp doctor          Run setup/health diagnostics
  vidlens-mcp setup           Configure detected MCP clients (Claude Desktop, Claude Code, Codex)
  vidlens-mcp update-deps     Refresh managed yt-dlp and Deno helper binaries

Common flags:
  --client <id>              Target client (claude_desktop, claude_code, codex)
  --data-dir <path>          Override VIDLENS_DATA_DIR for generated config
  --platform <id>            Doctor: show one platform readiness row
  --youtube-api-key <key>    Persist YOUTUBE_API_KEY into generated client config
  --gemini-api-key <key>     Persist GEMINI_API_KEY into generated client config
  --google-api-key <key>     Persist GOOGLE_API_KEY into generated client config
  --openai-api-key <key>     Persist OPENAI_API_KEY for OpenAI speech-to-text fallback
  --scrapecreators-api-key <key>
                              Persist SCRAPECREATORS_API_KEY for social trend search
  --brave-api-key <key>      Persist BRAVE_API_KEY for structured web discovery
  --serpapi-key <key>        Persist SERPAPI_KEY for structured web discovery
  --web-search-provider <id> Persist VIDLENS_WEB_SEARCH_PROVIDER (auto, brave, serpapi, duckduckgo, none)
  --stt-provider <id>        Persist VIDLENS_STT_PROVIDER (auto, whisper-cpp, gemini, openai, none)
  --cookies-from-browser <b> Persist browser cookie source for yt-dlp
  --advanced                Setup: prompt for optional keys, STT, web search, and cookies
  --yes, -y                  Setup: consent to install prompts non-interactively (yt-dlp, global install)
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

function describeUniversalSetupEnv(env: Record<string, string> | undefined): string {
  const ok = "\x1b[32m✓\x1b[0m";
  const skip = "\x1b[90m-\x1b[0m";
  const openai = env?.OPENAI_API_KEY ? ok : skip;
  const scrapeCreators = env?.SCRAPECREATORS_API_KEY ? ok : skip;
  const web = env?.BRAVE_API_KEY || env?.SERPAPI_KEY || env?.VIDLENS_WEB_SEARCH_PROVIDER ? ok : skip;
  const stt = env?.VIDLENS_STT_PROVIDER || env?.VIDLENS_STT_LANGUAGE_HINT || env?.VIDLENS_WHISPER_MODEL_PATH ? ok : skip;
  const cookies = env?.VIDLENS_COOKIES_FROM_BROWSER || env?.VIDLENS_YOUTUBE_COOKIES_FILE || env?.VIDLENS_X_COOKIES_FILE ||
    env?.VIDLENS_INSTAGRAM_COOKIES_FILE || env?.VIDLENS_TIKTOK_COOKIES_FILE ? ok : skip;
  return `OPENAI_API_KEY ${openai}  ScrapeCreators ${scrapeCreators}  web search ${web}  STT ${stt}  cookies ${cookies}`;
}

function setupSection(title: string): string {
  return `\n  \x1b[1m${title}\x1b[0m\n  ${"-".repeat(title.length)}\n`;
}

function setupItem(title: string, detail: string): string {
  return `  \x1b[33m${title}\x1b[0m\n    ${detail}\n`;
}

function setupHelp(text: string): string {
  return `    \x1b[2m${text}\x1b[0m\n`;
}

function setupDetected(label: string, value: string, detail?: string): string {
  return `    \x1b[32mSelected ${label}:\x1b[0m ${value}${detail ? ` (${detail})` : ""}\n`;
}

function setupWarn(text: string): string {
  return `    \x1b[33mNote:\x1b[0m ${text}\n`;
}

function detectFfmpegTools(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { ffmpeg?: string; ffprobe?: string; available: boolean } {
  const ffmpeg = commandOnPath("ffmpeg", env, platform);
  const ffprobe = commandOnPath("ffprobe", env, platform);
  return { ffmpeg, ffprobe, available: Boolean(ffmpeg && ffprobe) };
}

function ffmpegInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "brew install ffmpeg";
  }
  if (platform === "win32") {
    return "winget install Gyan.FFmpeg";
  }
  return "sudo apt install ffmpeg";
}

function redactSetupConfigForDisplay(text: string, parsed: ParsedCliArgs, env: NodeJS.ProcessEnv): string {
  const sensitiveKeys = [
    "YOUTUBE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "SCRAPECREATORS_API_KEY",
    "BRAVE_API_KEY",
    "SERPAPI_KEY",
    "VIDLENS_YOUTUBE_COOKIES_FILE",
    "VIDLENS_X_COOKIES_FILE",
    "VIDLENS_INSTAGRAM_COOKIES_FILE",
    "VIDLENS_TIKTOK_COOKIES_FILE",
  ];
  const secrets = [
    parsed.youtubeApiKey,
    parsed.geminiApiKey,
    parsed.googleApiKey,
    parsed.openaiApiKey,
    parsed.scrapeCreatorsApiKey,
    parsed.braveApiKey,
    parsed.serpapiKey,
    env.YOUTUBE_API_KEY,
    env.GEMINI_API_KEY,
    env.GOOGLE_API_KEY,
    env.OPENAI_API_KEY,
    env.SCRAPECREATORS_API_KEY,
    env.BRAVE_API_KEY,
    env.SERPAPI_KEY,
  ];
  let redacted = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      redacted = redacted.split(secret).join("<set>");
    }
  }
  for (const key of sensitiveKeys) {
    redacted = redacted.replace(
      new RegExp(`(^\\s*${key}\\s*=\\s*)"(?:\\\\.|[^"])*"`, "gm"),
      `$1"<set>"`,
    );
    redacted = redacted.replace(
      new RegExp(`(^\\s*"${key}"\\s*:\\s*)"(?:\\\\.|[^"])*"`, "gm"),
      `$1"<set>"`,
    );
  }
  return redacted;
}

const SETUP_BROWSER_COOKIE_SOURCES = new Set([
  "chrome",
  "safari",
  "firefox",
  "edge",
  "brave",
  "opera",
  "chromium",
  "vivaldi",
]);

function normalizeBrowserCookieSource(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return SETUP_BROWSER_COOKIE_SOURCES.has(normalized) ? normalized : undefined;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
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

function describeClaudeCodeCliInspection(inspection: ClaudeCodeCliInspection): string {
  switch (inspection.status) {
    case "connected":
      return "vidlens-mcp is connected in `claude mcp list`";
    case "listed":
      return "vidlens-mcp is listed in `claude mcp list`";
    case "not_listed":
      return "vidlens-mcp is not listed by `claude mcp list`";
    case "not_available":
      return "claude CLI not found; unable to run `claude mcp list`";
    case "error":
      return "unable to verify with `claude mcp list`";
    case "skipped":
      return inspection.detail;
    default:
      return inspection.detail;
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
          if (["YOUTUBE_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "SCRAPECREATORS_API_KEY", "BRAVE_API_KEY", "SERPAPI_KEY"].includes(key) && value) {
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

/**
 * Consent gate for actions that install software (yt-dlp download, global npm
 * install). `--yes` opts in unconditionally. Interactive TTYs are prompted and
 * default to yes on empty input. Non-interactive runs (pipes, CI) default to NO
 * and print a hint so scripts never silently install without `--yes`.
 */
async function confirmInstallConsent(question: string, parsed: ParsedCliArgs, deps: CliDeps): Promise<boolean> {
  if (parsed.assumeYes) {
    return true;
  }
  if (!deps.interactive) {
    deps.writeStderr("    Skipped (non-interactive input). Re-run with --yes to allow this automatically.\n");
    return false;
  }
  const answer = await deps.promptLine(question);
  return !answer || answer.trim().toLowerCase() !== "n";
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

function defaultRunCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env,
    timeout: options.timeoutMs ?? 20_000,
    shell: false,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error?.message,
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
