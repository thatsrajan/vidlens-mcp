import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";

export class SerpApiProvider implements WebSearchProvider {
  readonly id = "serpapi" as const;
  readonly limitations: string[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", withSites(query, options.sites));
    url.searchParams.set("num", String(Math.max(1, Math.min(options.maxResults ?? 8, 20))));
    url.searchParams.set("api_key", this.apiKey);
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`SerpAPI failed: HTTP ${response.status}`);
    }
    const data = await response.json() as { organic_results?: Array<{ link?: string; title?: string; snippet?: string }> };
    return (data.organic_results ?? [])
      .filter((item) => item.link)
      .map((item) => ({ url: item.link!, title: item.title, snippet: item.snippet }));
  }
}

function withSites(query: string, sites: string[] | undefined): string {
  if (!sites?.length) {
    return query;
  }
  return `${query} (${sites.map((site) => `site:${site}`).join(" OR ")})`;
}
