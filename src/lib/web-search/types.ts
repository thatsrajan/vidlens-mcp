import type { VideoSourcePlatform, WebSearchProviderId } from "../types.js";

export interface WebSearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

export interface WebSearchOptions {
  sites?: string[];
  maxResults?: number;
  platform?: VideoSourcePlatform;
}

export interface WebSearchProvider {
  readonly id: WebSearchProviderId;
  readonly limitations: string[];
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}
