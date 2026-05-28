import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

export function managedDenoPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dataDir, "bin", platform === "win32" ? "deno.exe" : "deno");
}

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
  const archivePath = join(binDir, "deno.zip");
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Deno download failed: HTTP ${response.status} from ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(archivePath, bytes);
  try {
    await execa("unzip", ["-o", archivePath, "-d", binDir], { timeout: 120_000 });
  } finally {
    try {
      unlinkSync(archivePath);
    } catch {
      // best effort cleanup
    }
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
