/**
 * VidLens MCP — Terminal banner
 */

const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Number of MCP tools exposed by the server. Single source of truth for every
 * banner surface (server startup, `setup` wizard, plain-text help).
 */
export const TOOL_COUNT = 47;

/**
 * Render the banner. Pass `version` to append it after the product name (used by
 * the setup wizard); pass `color: false` for an ANSI-free variant.
 */
export function renderBanner(options: { version?: string; color?: boolean } = {}): string {
  const color = options.color ?? true;
  const red = color ? RED : "";
  const dim = color ? DIM : "";
  const bold = color ? BOLD : "";
  const reset = color ? RESET : "";
  const versionSuffix = options.version ? ` v${options.version}` : "";
  return `
  ${red}▶${reset} ${bold}VidLens MCP${reset}${versionSuffix}
    Video intelligence layer for AI agents
    ${dim}${TOOL_COUNT} tools · zero config${reset}
`;
}

export function printBanner(): void {
  if (process.env.NO_COLOR || process.argv.includes("--quiet")) {
    return;
  }
  process.stderr.write(renderBanner() + "\n");
}

export const bannerPlain = renderBanner({ color: false });
