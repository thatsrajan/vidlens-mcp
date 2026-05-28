/**
 * VidLens MCP — Terminal banner
 */

const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const banner = `
  ${RED}▶${RESET} ${BOLD}VidLens MCP${RESET}
    Video intelligence layer for AI agents
    ${DIM}45 tools · zero config${RESET}
`;

export function printBanner(): void {
  if (process.env.NO_COLOR || process.argv.includes("--quiet")) {
    return;
  }
  process.stderr.write(banner + "\n");
}

export const bannerPlain = `
  ▶ VidLens MCP
    Video intelligence layer for AI agents
    45 tools · zero config
`;
