/**
 * VidLens MCP — Terminal banner
 * Colors matched to brand: red lens, teal handle, golden background, cream text
 */

const RED = "\x1b[91m";
const TEAL = "\x1b[36m";
const GOLD = "\x1b[33m";
const WHITE = "\x1b[97m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const banner = `
${RED}        ██████████
${RED}      ██${WHITE}██████████${RED}██
${RED}    ██${WHITE}██${RED}██████${WHITE}████${RED}██
${RED}    ██${WHITE}██${RED}████████${WHITE}██${RED}██
${RED}  ██${WHITE}██${RED}██████████${WHITE}██${RED}██
${RED}  ██${WHITE}██${RED}████${WHITE}▶${RED}█████${WHITE}██${RED}██
${RED}  ██${WHITE}██${RED}██████████${WHITE}██${RED}██
${RED}    ██${WHITE}██${RED}████████${WHITE}██${RED}██
${RED}    ██${WHITE}██${RED}██████${WHITE}████${RED}██
${RED}      ██${WHITE}██████████${RED}██
${RED}        ████████${TEAL}██${RED}██
${TEAL}              ████
${TEAL}              ████
${TEAL}                ██${RESET}

${GOLD}${BOLD}  ╦  ╦╦╔╦╗╦  ╔═╗╔╗╔╔═╗
${GOLD}  ╚╗╔╝║ ║║║  ║╣ ║║║╚═╗
${GOLD}   ╚╝ ╩═╩╝╩═╝╚═╝╝╚╝╚═╝${RESET}  ${DIM}MCP${RESET}

${WHITE}  Semantic search across your
${WHITE}  entire YouTube playlist.${RESET}
${DIM}  One SQLite file. Zero config.${RESET}
`;

export function printBanner(): void {
  // Respect NO_COLOR / --quiet conventions
  if (process.env.NO_COLOR || process.argv.includes("--quiet")) {
    return;
  }
  // Must use stderr — stdout is the MCP JSON-RPC transport
  process.stderr.write(banner + "\n");
}

export const bannerPlain = `
        ██████████
      ████████████████
    ██████████████████
    ██████████████████
  ██████████████████████
  ████████ ▶ ███████████
  ██████████████████████
    ██████████████████
    ██████████████████
      ████████████████
        ████████░░██
              ░░░░
              ░░░░
                ░░

  ╦  ╦╦╔╦╗╦  ╔═╗╔╗╔╔═╗
  ╚╗╔╝║ ║║║  ║╣ ║║║╚═╗
   ╚╝ ╩═╩╝╩═╝╚═╝╝╚╝╚═╝  MCP

  Semantic search across your
  entire YouTube playlist.
  One SQLite file. Zero config.
`;
