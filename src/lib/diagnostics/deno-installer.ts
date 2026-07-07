import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { DOWNLOAD_FETCH_TIMEOUT_MS } from "../fetch-timeout.js";

export function managedDenoPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dataDir, "bin", platform === "win32" ? "deno.exe" : "deno");
}

/** Sanity cap on the Deno archive download (~200MB; real zips are ~40MB). */
const MAX_DENO_ARCHIVE_BYTES = 200 * 1024 * 1024;

export async function ensureDeno(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const existing = managedDenoPath(dataDir, platform);
  if (existsSync(existing)) {
    return existing;
  }
  const binDir = join(dataDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const url = denoDownloadUrl(platform, arch);
  // Deno's release assets don't publish a stable checksum manifest at a
  // `latest/download` URL, so we can't verify a digest here (noted in the code
  // review). We still fail closed on an oversized/truncated archive and install
  // atomically so a partial unzip can't be accepted next run.
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Deno download failed: HTTP ${response.status} from ${url}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_DENO_ARCHIVE_BYTES) {
    throw new Error(`Deno download too large: ${declaredLength} bytes exceeds cap`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Deno download failed: empty response body");
  }
  if (bytes.length > MAX_DENO_ARCHIVE_BYTES) {
    throw new Error(`Deno download too large: ${bytes.length} bytes exceeds cap`);
  }

  // Unzip into a scratch dir, then atomically move the binary into place.
  const stagingDir = join(binDir, `.deno-stage.${process.pid}.${Date.now()}`);
  const archivePath = join(stagingDir, "deno.zip");
  const binName = platform === "win32" ? "deno.exe" : "deno";
  const stagedBinary = join(stagingDir, binName);
  mkdirSync(stagingDir, { recursive: true });
  try {
    writeFileSync(archivePath, bytes);
    await execa("unzip", ["-o", archivePath, "-d", stagingDir], { timeout: 120_000 });
    if (!existsSync(stagedBinary)) {
      throw new Error(`Deno archive did not contain expected binary "${binName}"`);
    }
    markExecutable(stagedBinary);
    renameSync(stagedBinary, existing);
  } finally {
    try {
      unlinkSync(archivePath);
    } catch {
      // best effort cleanup
    }
    rmSync(stagingDir, { recursive: true, force: true });
  }
  markExecutable(existing);
  return existing;
}

export function denoDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  const normalizedArch = arch === "arm64" || arch === "aarch64" ? "aarch64" : "x86_64";
  if (platform === "darwin") {
    return `https://github.com/denoland/deno/releases/latest/download/deno-${normalizedArch}-apple-darwin.zip`;
  }
  if (platform === "linux") {
    return `https://github.com/denoland/deno/releases/latest/download/deno-${normalizedArch}-unknown-linux-gnu.zip`;
  }
  if (platform === "win32") {
    return "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
  }
  throw new Error(`Unsupported Deno platform: ${platform} ${arch}`);
}

export async function probeDeno(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa(binary, ["--version"], { timeout: 10_000 });
    return stdout.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

export function markExecutable(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o755);
  }
}
