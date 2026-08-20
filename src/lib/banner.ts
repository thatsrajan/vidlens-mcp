/**
 * VidLens MCP — Terminal banner
 */

const RESET = "\x1b[0m";
const TRUECOLOR_INDIGO = "\x1b[38;2;4;79;103m";
const TRUECOLOR_GOLD = "\x1b[38;2;196;169;135m";
const ANSI256_INDIGO = "\x1b[38;5;30m";
const ANSI256_GOLD = "\x1b[38;5;180m";

export type BannerColorMode = "truecolor" | "ansi256" | "none";

export interface BannerOptions {
  version?: string;
  color?: boolean;
  colorMode?: BannerColorMode;
  env?: NodeJS.ProcessEnv;
}

/**
 * Number of MCP tools exposed by the server. Single source of truth for every
 * banner surface (server startup, `setup` wizard, plain-text help).
 */
export const TOOL_COUNT = 48;

/**
 * Render the lens-v3 install banner. Pass `version` to append it after the
 * wordmark; pass `color: false` for an ANSI-free variant.
 */
export function renderBanner(options: BannerOptions = {}): string {
  const mode = resolveBannerColorMode(options);
  const indigo = mode === "truecolor" ? TRUECOLOR_INDIGO : mode === "ansi256" ? ANSI256_INDIGO : "";
  const gold = mode === "truecolor" ? TRUECOLOR_GOLD : mode === "ansi256" ? ANSI256_GOLD : "";
  const reset = mode === "none" ? "" : RESET;
  const versionSuffix = options.version ? ` v${options.version}` : "";
  return `
      ${indigo}◢  ◣${reset}
    ${indigo}◀  ◇  ▶${reset}
      ${indigo}◥  ◤${reset}
    VidLens${versionSuffix}
    Your AI can read the web.
    ${indigo}Now it can also watch it.${reset}
    ${gold}─────  FREE · OPEN SOURCE · MIT${reset}
`;
}

export function resolveBannerColorMode(options: BannerOptions = {}): BannerColorMode {
  if (options.color === false) return "none";
  if (options.colorMode) return options.colorMode;
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined) return "none";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
  if (env.TERM === "dumb") return "none";
  return "ansi256";
}

export function printBanner(): void {
  if (process.env.NO_COLOR !== undefined || process.argv.includes("--quiet")) {
    return;
  }
  process.stderr.write(renderBanner({ env: process.env }) + "\n");
}

export const bannerPlain = renderBanner({ color: false });
