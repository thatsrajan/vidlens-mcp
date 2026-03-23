/**
 * yt-dlp binary management — auto-download and resolution.
 *
 * Downloads the correct platform-specific standalone binary from yt-dlp's
 * GitHub releases into the VidLens data directory. No brew, no PATH, no sudo.
 */

import { accessSync, chmodSync, constants, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { commandOnPath } from "./install-diagnostics.js";

const GITHUB_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

export type YtDlpSource = "managed" | "system";

export interface YtDlpResolution {
  path: string;
  source: YtDlpSource;
}

/**
 * Returns the download URL for the yt-dlp binary matching the given platform and architecture.
 */
export function ytDlpDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  if (platform === "win32") {
    return `${GITHUB_RELEASE_BASE}/yt-dlp.exe`;
  }
  if (platform === "darwin") {
    return `${GITHUB_RELEASE_BASE}/yt-dlp_macos`;
  }
  if (platform === "linux") {
    if (arch === "arm64" || arch === "aarch64") {
      return `${GITHUB_RELEASE_BASE}/yt-dlp_linux_aarch64`;
    }
    return `${GITHUB_RELEASE_BASE}/yt-dlp_linux`;
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

/**
 * Returns the path where the managed yt-dlp binary lives (or would live).
 */
export function managedBinaryPath(dataDir: string, platform: NodeJS.Platform): string {
  const binName = platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return join(dataDir, "bin", binName);
}

/**
 * Checks the managed data directory for an existing yt-dlp binary.
 * Returns the path if found and executable, undefined otherwise.
 */
export function resolveManagedBinary(dataDir: string, platform: NodeJS.Platform): string | undefined {
  const binPath = managedBinaryPath(dataDir, platform);
  if (!existsSync(binPath)) {
    return undefined;
  }
  try {
    accessSync(binPath, constants.X_OK);
    return binPath;
  } catch {
    return undefined;
  }
}

/**
 * Finds the best available yt-dlp binary — checks managed directory first, then system PATH.
 */
export function findYtDlpBinary(
  dataDir: string,
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv,
): YtDlpResolution | undefined {
  const managed = resolveManagedBinary(dataDir, platform);
  if (managed) {
    return { path: managed, source: "managed" };
  }
  const system = commandOnPath("yt-dlp", env, platform);
  if (system) {
    return { path: system, source: "system" };
  }
  return undefined;
}

/**
 * Downloads the yt-dlp binary into `<dataDir>/bin/` and returns the absolute path.
 */
export async function downloadYtDlp(
  dataDir: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<string> {
  const url = ytDlpDownloadUrl(platform, arch);
  const destPath = managedBinaryPath(dataDir, platform);
  const binDir = join(dataDir, "bin");

  mkdirSync(binDir, { recursive: true });

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }
  if (!response.body) {
    throw new Error("Download failed: empty response body");
  }

  // Stream the binary to disk to avoid buffering ~20MB in memory
  const { createWriteStream } = await import("node:fs");
  const fileStream = createWriteStream(destPath);
  const webStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  await pipeline(webStream, fileStream);

  if (platform !== "win32") {
    chmodSync(destPath, 0o755);
  }

  return destPath;
}
