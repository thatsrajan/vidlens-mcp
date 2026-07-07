/**
 * yt-dlp binary management — auto-download and resolution.
 *
 * Downloads the correct platform-specific standalone binary from yt-dlp's
 * GitHub releases into the VidLens data directory. No brew, no PATH, no sudo.
 */

import { accessSync, chmodSync, constants, mkdirSync, existsSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { commandOnPath } from "./install-diagnostics.js";
import { DEFAULT_FETCH_TIMEOUT_MS, DOWNLOAD_FETCH_TIMEOUT_MS } from "./fetch-timeout.js";

const GITHUB_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const CHECKSUMS_URL = `${GITHUB_RELEASE_BASE}/SHA2-256SUMS`;

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
 * Fetches the release `SHA2-256SUMS` file and returns the expected SHA-256 hex
 * digest for the given asset filename, or undefined if the checksum manifest is
 * unavailable or doesn't list the asset.
 */
export async function fetchExpectedChecksum(
  assetName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(CHECKSUMS_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  const text = await response.text();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (match && basename(match[2]) === assetName) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

/**
 * Downloads the yt-dlp binary into `<dataDir>/bin/` and returns the absolute path.
 *
 * The download is written to a temp file in the same directory, verified against
 * the release checksum, fsync'd, then atomically renamed into place — so a
 * truncated or corrupted download can never be accepted as a managed binary on
 * the next run.
 */
export async function downloadYtDlp(
  dataDir: string,
  platform: NodeJS.Platform,
  arch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = ytDlpDownloadUrl(platform, arch);
  const assetName = basename(new URL(url).pathname);
  const destPath = managedBinaryPath(dataDir, platform);
  const binDir = join(dataDir, "bin");
  const tempPath = join(binDir, `.${assetName}.${process.pid}.${Date.now()}.download`);

  mkdirSync(binDir, { recursive: true });

  const expectedChecksum = await fetchExpectedChecksum(assetName, fetchImpl);

  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Download failed: empty response body");
  }

  if (expectedChecksum) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedChecksum) {
      throw new Error(
        `Download checksum mismatch for ${assetName}: expected ${expectedChecksum}, got ${actual}`,
      );
    }
  }

  const handle = await open(tempPath, "w", 0o755);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, destPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  if (platform !== "win32") {
    chmodSync(destPath, 0o755);
  }

  return destPath;
}
