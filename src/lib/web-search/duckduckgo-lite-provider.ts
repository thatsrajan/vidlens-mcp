import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";

export class DuckDuckGoLiteProvider implements WebSearchProvider {
  readonly id = "duckduckgo_lite" as const;
  readonly limitations = ["DuckDuckGo HTML fallback is best-effort and may break without notice."];

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", withSites(query, options.sites));
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": "vidlens-mcp/1.3.0" },
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo-lite failed: HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDuckDuckGoHtml(html).slice(0, Math.max(1, options.maxResults ?? 8));
  }
}

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkPattern = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const rawUrl = decodeDuckDuckGoUrl(decodeHtml(match[1] ?? ""));
    if (!rawUrl) {
      continue;
    }
    results.push({
      url: rawUrl,
      title: stripTags(decodeHtml(match[2] ?? "")).trim(),
    });
  }
  return results;
}

function withSites(query: string, sites: string[] | undefined): string {
  if (!sites?.length) {
    return query;
  }
  return `${query} (${sites.map((site) => `site:${site}`).join(" OR ")})`;
}

function decodeDuckDuckGoUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return undefined;
  }
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
