import { accessSync, constants } from "node:fs";
import type { VideoSourcePlatform } from "../types.js";

export type BrowserCookieSource =
  | "chrome"
  | "safari"
  | "firefox"
  | "edge"
  | "brave"
  | "opera"
  | "chromium"
  | "vivaldi";

export interface CookieResolution {
  mode: "file" | "browser" | "none";
  args: string[];
  path?: string;
  browser?: BrowserCookieSource;
  profile?: string;
  warning?: string;
}

const COOKIE_ENV_BY_PLATFORM: Partial<Record<VideoSourcePlatform, string>> = {
  youtube: "VIDLENS_YOUTUBE_COOKIES_FILE",
  x: "VIDLENS_X_COOKIES_FILE",
  instagram: "VIDLENS_INSTAGRAM_COOKIES_FILE",
  tiktok: "VIDLENS_TIKTOK_COOKIES_FILE",
};

const SUPPORTED_BROWSERS = new Set<BrowserCookieSource>([
  "chrome",
  "safari",
  "firefox",
  "edge",
  "brave",
  "opera",
  "chromium",
  "vivaldi",
]);

export class CookieStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  argsFor(platform: VideoSourcePlatform): string[] {
    return this.resolve(platform).args;
  }

  resolve(platform: VideoSourcePlatform): CookieResolution {
    const envKey = COOKIE_ENV_BY_PLATFORM[platform];
    const cookiePath = envKey ? this.env[envKey] : undefined;
    if (cookiePath) {
      if (isReadable(cookiePath)) {
        return {
          mode: "file",
          path: cookiePath,
          args: ["--cookies", cookiePath],
        };
      }
      return {
        mode: "none",
        args: [],
        path: cookiePath,
        warning: `${envKey} is set but is not readable: ${cookiePath}`,
      };
    }

    const browser = parseBrowser(this.env.VIDLENS_COOKIES_FROM_BROWSER);
    if (browser) {
      const profile = this.env.VIDLENS_COOKIES_PROFILE?.trim();
      return {
        mode: "browser",
        browser,
        profile: profile || undefined,
        args: ["--cookies-from-browser", profile ? `${browser}:${profile}` : browser],
      };
    }

    return { mode: "none", args: [] };
  }
}

export function cookieEnvKeyForPlatform(platform: VideoSourcePlatform): string | undefined {
  return COOKIE_ENV_BY_PLATFORM[platform];
}

function parseBrowser(value: string | undefined): BrowserCookieSource | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return SUPPORTED_BROWSERS.has(normalized as BrowserCookieSource)
    ? normalized as BrowserCookieSource
    : undefined;
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
