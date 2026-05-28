import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";

export class BraveSearchProvider implements WebSearchProvider {
  readonly id = "brave" as const;
  readonly limitations: string[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const q = withSites(query, options.sites);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", q);
    url.searchParams.set("count", String(Math.max(1, Math.min(options.maxResults ?? 8, 20))));
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`Brave Search failed: HTTP ${response.status}`);
    }
    const data = await response.json() as { web?: { results?: Array<{ url?: string; title?: string; description?: string }> } };
    return (data.web?.results ?? [])
      .filter((item) => item.url)
      .map((item) => ({ url: item.url!, title: item.title, snippet: item.description }));
  }
}

function withSites(query: string, sites: string[] | undefined): string {
  if (!sites?.length) {
    return query;
  }
  return `${query} (${sites.map((site) => `site:${site}`).join(" OR ")})`;
}
