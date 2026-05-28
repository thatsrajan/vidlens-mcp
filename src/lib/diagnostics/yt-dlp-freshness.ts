import type { YtDlpFreshnessStatus } from "../types.js";

export interface YtDlpFreshness {
  version?: string;
  status: YtDlpFreshnessStatus;
  ageDays?: number;
  latestVersion?: string;
  recommendation?: string;
}

export function assessYtDlpFreshness(
  version: string | undefined,
  now = new Date(),
  latestVersion?: string,
): YtDlpFreshness {
  const parsed = version ? parseYtDlpDateVersion(version) : undefined;
  if (!version || !parsed) {
    return {
      version,
      status: "unknown",
      latestVersion,
      recommendation: "Run `vidlens-mcp update-deps` or install a current yt-dlp release.",
    };
  }

  const ageDays = Math.max(0, Math.floor((startOfDay(now).getTime() - parsed.getTime()) / 86_400_000));
  const status: YtDlpFreshnessStatus = ageDays < 30
    ? "fresh"
    : ageDays <= 90
      ? "stale"
      : "severely_stale";

  return {
    version,
    status,
    ageDays,
    latestVersion,
    recommendation: recommendYtDlpUpdate(status, latestVersion),
  };
}

export async function fetchLatestYtDlpVersion(fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetchImpl("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    return undefined;
  }
  const body = await response.json() as { tag_name?: string; name?: string };
  return (body.tag_name ?? body.name)?.replace(/^yt-dlp\s+/i, "");
}

export function parseYtDlpDateVersion(version: string): Date | undefined {
  const match = version.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) {
    return undefined;
  }
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

export function recommendYtDlpUpdate(status: YtDlpFreshnessStatus, latestVersion?: string): string | undefined {
  if (status === "fresh") {
    return latestVersion ? `yt-dlp is fresh. Latest upstream: ${latestVersion}.` : "yt-dlp is fresh.";
  }
  if (status === "stale") {
    return "yt-dlp is stale. Run `vidlens-mcp update-deps` for the managed binary or upgrade your system yt-dlp.";
  }
  if (status === "severely_stale") {
    return "yt-dlp is severely stale. Update before relying on YouTube, TikTok, X, or Instagram extraction.";
  }
  return "yt-dlp freshness is unknown. Run `vidlens-mcp update-deps` or install yt-dlp from a trusted package manager.";
}

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
