import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

export interface JsRuntimeProbe {
  runtime: "deno" | "node" | "none";
  version?: string;
  source: "managed" | "system" | "none";
  binary?: string;
}

export async function probeJsRuntime(options: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
} = {}): Promise<JsRuntimeProbe> {
  const dataDir = options.dataDir;
  const managedDeno = dataDir ? join(dataDir, "bin", process.platform === "win32" ? "deno.exe" : "deno") : undefined;
  if (managedDeno && existsSync(managedDeno)) {
    const version = await probeVersion(managedDeno, ["--version"]);
    if (version) {
      return { runtime: "deno", version, source: "managed", binary: managedDeno };
    }
  }

  const systemDeno = await probeVersion("deno", ["--version"]);
  if (systemDeno) {
    return { runtime: "deno", version: systemDeno, source: "system", binary: "deno" };
  }

  const nodeBinary = options.nodePath ?? process.execPath;
  const nodeVersion = await probeVersion(nodeBinary, ["--version"]);
  if (nodeVersion) {
    return { runtime: "node", version: nodeVersion, source: "system", binary: nodeBinary };
  }

  return { runtime: "none", source: "none" };
}

export function ytdlpJsRuntimeEnv(runtime: JsRuntimeProbe): Record<string, string> {
  if (runtime.runtime === "none" || !runtime.binary) {
    return {};
  }
  return { YTDLP_JS_RUNTIME: runtime.binary };
}

async function probeVersion(binary: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execa(binary, args, { timeout: 10_000, reject: true });
    return stdout.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}
