import { BraveSearchProvider } from "./brave-provider.js";
import { DuckDuckGoLiteProvider } from "./duckduckgo-lite-provider.js";
import { SerpApiProvider } from "./serpapi-provider.js";
import type { WebSearchProvider } from "./types.js";

export type WebSearchSelection = "auto" | "brave" | "serpapi" | "duckduckgo" | "none";

export interface WebSearchSelectionResult {
  provider: WebSearchProvider | null;
  providerId: "brave" | "serpapi" | "duckduckgo_lite" | "none";
  details: string[];
}

export function selectWebSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): WebSearchSelectionResult {
  const requested = normalizeSelection(env.VIDLENS_WEB_SEARCH_PROVIDER);
  if (requested === "none") {
    return { provider: null, providerId: "none", details: ["Web-search fallback disabled by VIDLENS_WEB_SEARCH_PROVIDER=none."] };
  }

  if ((requested === "auto" || requested === "brave") && env.BRAVE_API_KEY) {
    return { provider: new BraveSearchProvider(env.BRAVE_API_KEY, fetchImpl), providerId: "brave", details: ["Selected Brave Search API."] };
  }
  if (requested === "brave") {
    return { provider: null, providerId: "none", details: ["BRAVE_API_KEY is required for Brave Search."] };
  }

  if ((requested === "auto" || requested === "serpapi") && env.SERPAPI_KEY) {
    return { provider: new SerpApiProvider(env.SERPAPI_KEY, fetchImpl), providerId: "serpapi", details: ["Selected SerpAPI."] };
  }
  if (requested === "serpapi") {
    return { provider: null, providerId: "none", details: ["SERPAPI_KEY is required for SerpAPI."] };
  }

  if (requested === "auto" || requested === "duckduckgo") {
    return {
      provider: new DuckDuckGoLiteProvider(fetchImpl),
      providerId: "duckduckgo_lite",
      details: ["Selected DuckDuckGo-lite best-effort HTML fallback."],
    };
  }

  return { provider: null, providerId: "none", details: ["No web-search provider selected."] };
}

function normalizeSelection(value: string | undefined): WebSearchSelection {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "brave":
    case "serpapi":
    case "duckduckgo":
    case "none":
      return normalized;
    default:
      return "auto";
  }
}
