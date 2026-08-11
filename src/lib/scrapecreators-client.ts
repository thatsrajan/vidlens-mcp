import type {
  SearchSocialTrendsInput,
  SearchSocialTrendsOutput,
  SocialSearchPlatform,
  SocialTrendResult,
} from "./types.js";
import { assertPublicHttpUrl } from "./url-guard.js";

type JsonObject = Record<string, unknown>;

interface EndpointPlan {
  platform: SocialSearchPlatform;
  endpoint: string;
  params: Record<string, string | number | boolean | undefined>;
  detail: string;
}

export interface ResolvedXMedia {
  url: string;
  bitrate?: number;
  contentType: "video/mp4";
}

const X_POPULAR_SAMPLE_LIMITATION =
  "X user-tweets returns a sample of popular tweets, not a chronological latest-tweets feed. Treat sort=recent as newest within that sample only, and verify the actual latest post through chronological X/web discovery.";

export class ScrapeCreatorsClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.scrapecreators.com",
  ) {}

  async search(input: SearchSocialTrendsInput): Promise<Pick<SearchSocialTrendsOutput, "results" | "searched" | "limitations">> {
    const platforms = input.platforms?.length ? input.platforms : DEFAULT_SOCIAL_PLATFORMS;
    const maxResults = Math.max(1, Math.min(input.maxResults ?? 12, 50));
    const plans = platforms.map((platform) => buildEndpointPlan(platform, input)).filter((plan): plan is EndpointPlan => Boolean(plan));
    const results: SocialTrendResult[] = [];
    const searched: SearchSocialTrendsOutput["searched"] = [];
    const limitations: string[] = [];

    for (const platform of platforms) {
      const plan = plans.find((candidate) => candidate.platform === platform);
      if (!plan) {
        searched.push({
          platform,
          status: "skipped",
          detail: platform === "x"
            ? "ScrapeCreators exposes X profile/community endpoints, but no general X keyword search endpoint is documented. Use a handle like @example to sample popular user tweets."
            : "No ScrapeCreators search endpoint is mapped for this platform yet.",
        });
        limitations.push(`${platform}: no mapped ScrapeCreators keyword/trending search endpoint.`);
        continue;
      }

      if (platform === "x") {
        limitations.push(X_POPULAR_SAMPLE_LIMITATION);
      }

      try {
        const data = await this.get(plan.endpoint, plan.params);
        const normalized = normalizeResults(platform, data, input.includeRaw === true).slice(0, maxResults);
        results.push(...normalized);
        searched.push({
          platform,
          endpoint: plan.endpoint,
          status: normalized.length > 0 ? "ok" : "partial",
          detail: `${plan.detail}; returned ${normalized.length} normalized item(s).`,
        });
      } catch (error) {
        searched.push({
          platform,
          endpoint: plan.endpoint,
          status: "partial",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      results: dedupeByUrl(results).slice(0, maxResults),
      searched,
      limitations,
    };
  }

  /**
   * Resolve an individual public X status to its best MP4 rendition. The raw
   * tweet payload is intentionally kept inside this client: callers receive
   * only the selected public media URL and its bitrate.
   */
  async resolveXMedia(tweetUrl: string): Promise<ResolvedXMedia> {
    const source = new URL(tweetUrl);
    const host = source.hostname.toLowerCase().replace(/^www\./, "");
    if (source.protocol !== "https:" || (host !== "x.com" && host !== "twitter.com")) {
      throw new Error("ScrapeCreators X media resolution requires an https://x.com or https://twitter.com status URL.");
    }
    if (!/(?:^|\/)status(?:es)?\/\d+(?:\/|$)/.test(source.pathname)) {
      throw new Error("ScrapeCreators X media resolution requires a status URL containing a numeric tweet ID.");
    }

    const data = await this.get("/v1/twitter/tweet", { url: tweetUrl, trim: false });
    const variants = primaryXMediaRoots(data).flatMap(collectMp4Variants)
      .filter((variant) => {
        try {
          assertPublicHttpUrl(variant.url);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => (b.bitrate ?? -1) - (a.bitrate ?? -1));
    const selected = variants[0];
    if (!selected) {
      throw new Error("ScrapeCreators tweet response did not include a public MP4 media variant.");
    }
    return selected;
  }

  private async get(path: string, params: Record<string, string | number | boolean | undefined>): Promise<JsonObject> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "x-api-key": this.apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`ScrapeCreators ${path} failed: HTTP ${response.status}`);
    }
    return await response.json() as JsonObject;
  }
}

function primaryXMediaRoots(data: JsonObject): unknown[] {
  const envelopes = [
    data,
    objectAt(data, "data"),
    objectAt(data, "tweet"),
    objectAt(objectAt(data, "data"), "tweet"),
    objectAt(objectAt(data, "tweetResult"), "result"),
    objectAt(objectAt(objectAt(data, "data"), "tweetResult"), "result"),
  ].filter((value): value is JsonObject => Boolean(value));
  const roots: unknown[] = [];
  for (const envelope of envelopes) {
    const legacy = objectAt(envelope, "legacy");
    const extended = objectAt(legacy, "extended_entities") ?? objectAt(envelope, "extended_entities");
    if (extended) roots.push(extended);
  }
  // Unknown response envelopes still get a bounded compatibility scan. Known
  // envelopes stay scoped to the primary tweet so a quoted tweet's larger
  // rendition cannot be selected by accident.
  return roots.length > 0 ? roots : [data];
}

function collectMp4Variants(root: unknown): ResolvedXMedia[] {
  const found = new Map<string, ResolvedXMedia>();
  const pending: unknown[] = [root];
  let visited = 0;

  while (pending.length > 0 && visited < 20_000) {
    const value = pending.pop();
    visited += 1;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;

    const item = value as JsonObject;
    const url = stringAt(item, "url") ?? stringAt(item, "src");
    const contentType = (stringAt(item, "content_type") ?? stringAt(item, "contentType") ?? stringAt(item, "type"))?.toLowerCase();
    if (url && (contentType === "video/mp4" || isMp4Url(url))) {
      const rawBitrate = numberAt(item, "bitrate") ?? numberAt(item, "bit_rate");
      const candidate: ResolvedXMedia = {
        url,
        bitrate: rawBitrate,
        contentType: "video/mp4",
      };
      const existing = found.get(url);
      if (!existing || (candidate.bitrate ?? -1) > (existing.bitrate ?? -1)) {
        found.set(url, candidate);
      }
    }
    pending.push(...Object.values(item));
  }

  return [...found.values()];
}

function isMp4Url(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".mp4");
  } catch {
    return false;
  }
}

export const DEFAULT_SOCIAL_PLATFORMS: SocialSearchPlatform[] = ["tiktok", "instagram", "threads", "pinterest", "reddit", "x"];

export function buildSocialPlaylist(query: string, results: SocialTrendResult[]): SearchSocialTrendsOutput["playlist"] {
  return {
    title: `Social trend results for ${query}`,
    itemCount: results.length,
    importableUrls: results.filter((item) => item.importableVideoSource).map((item) => item.url),
    platforms: Array.from(new Set(results.map((item) => item.platform))),
  };
}

export function sortSocialTrendResults(
  results: SocialTrendResult[],
  sort: SearchSocialTrendsInput["sort"] = "engagement",
): SocialTrendResult[] {
  if (sort === "relevance") {
    return [...results];
  }
  if (sort === "recent") {
    return [...results].sort((a, b) => {
      const dateDifference = sortableDate(b.publishedAt) - sortableDate(a.publishedAt);
      return dateDifference || (b.score ?? 0) - (a.score ?? 0);
    });
  }
  return [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function sampleSocialTrends(input: SearchSocialTrendsInput): Pick<SearchSocialTrendsOutput, "results" | "searched" | "limitations"> {
  const platforms: SocialSearchPlatform[] = input.platforms?.length ? input.platforms : ["tiktok", "instagram", "threads", "reddit"];
  const maxResults = Math.max(1, Math.min(input.maxResults ?? 8, 25));
  const results = platforms.flatMap((platform, index) => sampleResult(platform, input.query, index)).slice(0, maxResults);
  return {
    results,
    searched: platforms.map((platform) => ({
      platform,
      endpoint: "dry-run",
      status: "ok" as const,
      detail: "Dry-run ScrapeCreators fixture.",
    })),
    limitations: ["Dry-run mode: no ScrapeCreators API request was made."],
  };
}

function buildEndpointPlan(platform: SocialSearchPlatform, input: SearchSocialTrendsInput): EndpointPlan | undefined {
  const freshness = input.freshness ?? "month";
  const sort = input.sort ?? "engagement";
  const region = (input.regionCode ?? "US").toUpperCase();
  switch (platform) {
    case "tiktok":
      return {
        platform,
        endpoint: "/v1/tiktok/search/top",
        params: {
          query: input.query,
          publish_time: tiktokFreshness(freshness),
          sort_by: tiktokSort(sort),
          region,
          cursor: 0,
        },
        detail: "Searched TikTok Top Search through ScrapeCreators",
      };
    case "instagram":
      return {
        platform,
        endpoint: "/v2/instagram/reels/search",
        params: {
          query: input.query,
          date_posted: instagramFreshness(freshness),
          page: 1,
        },
        detail: "Searched Instagram reels through ScrapeCreators",
      };
    case "threads":
      return {
        platform,
        endpoint: "/v1/threads/search",
        params: {
          query: input.query,
          ...dateWindowParams(freshness),
          trim: true,
        },
        detail: "Searched Threads posts through ScrapeCreators",
      };
    case "pinterest":
      return {
        platform,
        endpoint: "/v1/pinterest/search",
        params: { query: input.query, trim: true },
        detail: "Searched Pinterest pins through ScrapeCreators",
      };
    case "reddit":
      return {
        platform,
        endpoint: "/v1/reddit/search",
        params: {
          query: input.query,
          sort: redditSort(sort),
          timeframe: redditFreshness(freshness),
          trim: true,
        },
        detail: "Searched Reddit posts through ScrapeCreators",
      };
    case "x": {
      const handle = extractHandle(input.query);
      if (!handle) return undefined;
      return {
        platform,
        endpoint: "/v1/twitter/user-tweets",
        // The trimmed response omits core.user_results on current ScrapeCreators
        // responses, which removes the screen name needed to build canonical URLs.
        params: { handle, trim: false },
        detail: `Fetched a popular-tweets sample for @${handle} through ScrapeCreators; this endpoint is not a chronological latest-tweets feed`,
      };
    }
  }
}

function normalizeResults(platform: SocialSearchPlatform, data: JsonObject, includeRaw: boolean): SocialTrendResult[] {
  switch (platform) {
    case "tiktok":
      return arrayAt(data, "items", "search_item_list", "aweme_list")
        .map((item) => normalizeTikTok(unwrapAweme(item), includeRaw))
        .filter(isTrendResult);
    case "instagram":
      return arrayAt(data, "reels", "items")
        .map((item) => normalizeInstagram(asObject(item), includeRaw))
        .filter(isTrendResult);
    case "threads":
      return arrayAt(data, "posts", "items")
        .map((item) => normalizeThreads(asObject(item), includeRaw))
        .filter(isTrendResult);
    case "pinterest":
      return arrayAt(data, "pins", "items")
        .map((item) => normalizePinterest(asObject(item), includeRaw))
        .filter(isTrendResult);
    case "reddit":
      return arrayAt(data, "posts", "children", "items")
        .map((item) => normalizeReddit(unwrapReddit(item), includeRaw))
        .filter(isTrendResult);
    case "x":
      return arrayAt(data, "tweets", "items")
        .map((item) => normalizeTweet(asObject(item), includeRaw))
        .filter(isTrendResult);
  }
}

function normalizeTikTok(item: JsonObject, includeRaw: boolean): SocialTrendResult | undefined {
  const id = stringAt(item, "id") ?? stringAt(item, "aweme_id");
  const author = objectAt(item, "author");
  const handle = stringAt(author, "unique_id") ?? stringAt(author, "handle");
  const url = stringAt(item, "url") ?? (id && handle ? `https://www.tiktok.com/@${handle}/video/${id}` : undefined);
  if (!id || !url) return undefined;
  const stats = objectAt(item, "statistics");
  return cleanResult({
    platform: "tiktok",
    sourceId: id,
    url,
    title: titleFrom(stringAt(item, "desc")),
    text: stringAt(item, "desc"),
    creator: stringAt(author, "nickname") ?? handle,
    creatorUrl: handle ? `https://www.tiktok.com/@${handle}` : undefined,
    publishedAt: dateFrom(item, "create_time_utc", "create_time"),
    thumbnailUrl: firstUrl(objectAt(objectAt(item, "video"), "cover")),
    durationSec: numberAt(objectAt(item, "video"), "duration"),
    metrics: {
      views: numberAt(stats, "play_count"),
      likes: numberAt(stats, "digg_count"),
      comments: numberAt(stats, "comment_count"),
      shares: numberAt(stats, "share_count"),
      saves: numberAt(stats, "collect_count"),
    },
    score: engagementScore(stats),
    importableVideoSource: true,
    matchReason: "Matched by ScrapeCreators TikTok search.",
    raw: includeRaw ? item : undefined,
  });
}

function normalizeInstagram(item: JsonObject, includeRaw: boolean): SocialTrendResult | undefined {
  const shortcode = stringAt(item, "shortcode") ?? stringAt(item, "code") ?? stringAt(item, "id");
  const url = stringAt(item, "url") ?? (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : undefined);
  if (!shortcode || !url) return undefined;
  const user = objectAt(item, "user") ?? objectAt(item, "owner");
  return cleanResult({
    platform: "instagram",
    sourceId: shortcode,
    url,
    title: titleFrom(stringAt(item, "caption") ?? stringAt(item, "title")),
    text: stringAt(item, "caption") ?? stringAt(item, "text"),
    creator: stringAt(user, "username") ?? stringAt(user, "full_name"),
    creatorUrl: stringAt(user, "username") ? `https://www.instagram.com/${stringAt(user, "username")}/` : undefined,
    publishedAt: dateFrom(item, "taken_at", "timestamp", "created_at"),
    thumbnailUrl: stringAt(item, "thumbnail_url") ?? stringAt(item, "display_url"),
    durationSec: numberAt(item, "video_duration"),
    metrics: {
      views: numberAt(item, "video_view_count") ?? numberAt(item, "play_count"),
      likes: numberAt(item, "like_count"),
      comments: numberAt(item, "comment_count"),
      shares: numberAt(item, "share_count"),
    },
    score: engagementScore(item),
    importableVideoSource: true,
    matchReason: "Matched by ScrapeCreators Instagram reels search.",
    raw: includeRaw ? item : undefined,
  });
}

function normalizeThreads(item: JsonObject, includeRaw: boolean): SocialTrendResult | undefined {
  const id = stringAt(item, "id") ?? stringAt(item, "pk");
  if (!id) return undefined;
  const user = objectAt(item, "user");
  const username = stringAt(user, "username");
  return cleanResult({
    platform: "threads",
    sourceId: id,
    url: stringAt(item, "url") ?? `https://www.threads.net/@${username ?? "unknown"}/post/${id}`,
    title: titleFrom(stringAt(item, "caption") ?? stringAt(item, "text")),
    text: stringAt(item, "caption") ?? stringAt(item, "text"),
    creator: username ?? stringAt(user, "full_name"),
    creatorUrl: username ? `https://www.threads.net/@${username}` : undefined,
    publishedAt: dateFrom(item, "taken_at", "created_at", "timestamp"),
    metrics: {
      likes: numberAt(item, "like_count"),
      comments: numberAt(item, "reply_count") ?? numberAt(item, "comment_count"),
    },
    score: engagementScore(item),
    importableVideoSource: false,
    matchReason: "Matched by ScrapeCreators Threads search.",
    raw: includeRaw ? item : undefined,
  });
}

function normalizePinterest(item: JsonObject, includeRaw: boolean): SocialTrendResult | undefined {
  const id = stringAt(item, "id") ?? stringAt(item, "node_id");
  const url = stringAt(item, "url");
  if (!id || !url) return undefined;
  const images = objectAt(item, "images");
  const orig = objectAt(images, "orig");
  return cleanResult({
    platform: "pinterest",
    sourceId: id,
    url,
    title: titleFrom(stringAt(item, "title") ?? stringAt(item, "description")),
    text: stringAt(item, "description") ?? stringAt(item, "auto_alt_text"),
    creator: stringAt(objectAt(item, "pinner"), "username") ?? stringAt(objectAt(item, "pinner"), "full_name"),
    thumbnailUrl: stringAt(orig, "url"),
    metrics: {
      saves: numberAt(item, "repin_count") ?? numberAt(item, "save_count"),
      comments: numberAt(item, "comment_count"),
    },
    score: engagementScore(item),
    importableVideoSource: false,
    matchReason: "Matched by ScrapeCreators Pinterest search.",
    raw: includeRaw ? item : undefined,
  });
}

function normalizeReddit(item: JsonObject, includeRaw: boolean): SocialTrendResult | undefined {
  const id = stringAt(item, "id") ?? stringAt(item, "name");
  if (!id) return undefined;
  const permalink = stringAt(item, "permalink");
  const url = stringAt(item, "url") ?? (permalink ? `https://www.reddit.com${permalink}` : undefined);
  if (!url) return undefined;
  return cleanResult({
    platform: "reddit",
    sourceId: id,
    url,
    title: stringAt(item, "title"),
    text: stringAt(item, "selftext") ?? stringAt(item, "body"),
    creator: stringAt(item, "author") ?? stringAt(item, "subreddit"),
    creatorUrl: stringAt(item, "subreddit") ? `https://www.reddit.com/r/${stringAt(item, "subreddit")}/` : undefined,
    publishedAt: dateFrom(item, "created_utc", "created"),
    thumbnailUrl: stringAt(item, "thumbnail"),
    metrics: {
      likes: numberAt(item, "score") ?? numberAt(item, "ups"),
      comments: numberAt(item, "num_comments"),
    },
    score: engagementScore(item),
    importableVideoSource: isVideoUrl(url),
    matchReason: "Matched by ScrapeCreators Reddit search.",
    raw: includeRaw ? item : undefined,
  });
}

function normalizeTweet(item: JsonObject, includeRaw: boolean): SocialTrendResult | undefined {
  const id = stringAt(item, "rest_id") ?? stringAt(item, "id");
  const legacy = objectAt(item, "legacy");
  const user = objectAt(objectAt(objectAt(item, "core"), "user_results"), "result");
  const userLegacy = objectAt(user, "legacy");
  const itemUrl = stringAt(item, "url");
  const handle = stringAt(userLegacy, "screen_name") ?? handleFromXUrl(itemUrl);
  if (!id || !handle) return undefined;
  return cleanResult({
    platform: "x",
    sourceId: id,
    url: `https://x.com/${handle}/status/${id}`,
    title: titleFrom(stringAt(legacy, "full_text")),
    text: stringAt(legacy, "full_text"),
    creator: stringAt(userLegacy, "name") ?? handle,
    creatorUrl: `https://x.com/${handle}`,
    publishedAt: legacy ? dateFrom(legacy, "created_at") : undefined,
    metrics: {
      views: numberFromUnknown(objectAt(item, "views")?.count),
      likes: numberAt(legacy, "favorite_count"),
      comments: numberAt(legacy, "reply_count"),
      shares: numberAt(legacy, "retweet_count"),
      saves: numberAt(legacy, "bookmark_count"),
    },
    score: engagementScore(legacy),
    importableVideoSource: false,
    matchReason: "Matched by ScrapeCreators X user tweets endpoint.",
    raw: includeRaw ? item : undefined,
  });
}

function handleFromXUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})\/status\//i);
  return match?.[1];
}

function sampleResult(platform: SocialSearchPlatform, query: string, index: number): SocialTrendResult[] {
  const id = String(1000 + index);
  const common = {
    title: `Dry-run ${platform} trend for ${query}`,
    text: `Sample social result about ${query}`,
    creator: "Sample Creator",
    metrics: { views: 100_000 + index, likes: 5_000 + index, comments: 250 + index },
    score: 105_250 + index,
  };
  switch (platform) {
    case "tiktok":
      return [{ platform, sourceId: id, url: `https://www.tiktok.com/@vidlens/video/${id}`, importableVideoSource: true, matchReason: "Dry-run ScrapeCreators fixture.", ...common }];
    case "instagram":
      return [{ platform, sourceId: "C0DEVIDLENS", url: "https://www.instagram.com/reel/C0DEVIDLENS/", importableVideoSource: true, matchReason: "Dry-run ScrapeCreators fixture.", ...common }];
    case "x":
      return [{ platform, sourceId: id, url: `https://x.com/vidlens/status/${id}`, importableVideoSource: false, matchReason: "Dry-run ScrapeCreators fixture.", ...common }];
    case "threads":
      return [{ platform, sourceId: id, url: `https://www.threads.net/@vidlens/post/${id}`, importableVideoSource: false, matchReason: "Dry-run ScrapeCreators fixture.", ...common }];
    case "pinterest":
      return [{ platform, sourceId: id, url: `https://www.pinterest.com/pin/${id}/`, importableVideoSource: false, matchReason: "Dry-run ScrapeCreators fixture.", ...common }];
    case "reddit":
      return [{ platform, sourceId: id, url: `https://www.reddit.com/r/vidlens/comments/${id}/sample/`, importableVideoSource: false, matchReason: "Dry-run ScrapeCreators fixture.", ...common }];
  }
}

function arrayAt(data: JsonObject, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function objectAt(value: unknown, key: string): JsonObject | undefined {
  const obj = asObject(value);
  const raw = obj[key];
  return raw && typeof raw === "object" ? raw as JsonObject : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const raw = asObject(value)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  return numberFromUnknown(asObject(value)[key]);
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function unwrapAweme(item: unknown): JsonObject {
  const obj = asObject(item);
  return objectAt(obj, "aweme_info") ?? obj;
}

function unwrapReddit(item: unknown): JsonObject {
  const obj = asObject(item);
  return objectAt(obj, "data") ?? obj;
}

function dateFrom(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw;
    const num = numberFromUnknown(raw);
    if (num !== undefined) {
      const millis = num > 10_000_000_000 ? num : num * 1000;
      return new Date(millis).toISOString();
    }
  }
  return undefined;
}

function sortableDate(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function firstUrl(value: JsonObject | undefined): string | undefined {
  const list = value?.url_list;
  return Array.isArray(list) && typeof list[0] === "string" ? list[0] : stringAt(value, "url");
}

function titleFrom(text?: string): string | undefined {
  return text?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
}

function engagementScore(value: unknown): number | undefined {
  const score = (numberAt(value, "play_count") ?? 0)
    + (numberAt(value, "view_count") ?? 0)
    + (numberAt(value, "views") ?? 0)
    + (numberAt(value, "digg_count") ?? 0) * 10
    + (numberAt(value, "like_count") ?? 0) * 10
    + (numberAt(value, "favorite_count") ?? 0) * 10
    + (numberAt(value, "score") ?? 0) * 10
    + (numberAt(value, "comment_count") ?? 0) * 25
    + (numberAt(value, "num_comments") ?? 0) * 25
    + (numberAt(value, "share_count") ?? 0) * 20
    + (numberAt(value, "retweet_count") ?? 0) * 20
    + (numberAt(value, "bookmark_count") ?? 0) * 15
    + (numberAt(value, "collect_count") ?? 0) * 15;
  return score > 0 ? score : undefined;
}

function cleanResult(result: SocialTrendResult): SocialTrendResult {
  const metrics = result.metrics && Object.values(result.metrics).some((value) => value !== undefined)
    ? result.metrics
    : undefined;
  return { ...result, metrics };
}

function isTrendResult(value: SocialTrendResult | undefined): value is SocialTrendResult {
  return Boolean(value?.url && value.sourceId);
}

function dedupeByUrl(results: SocialTrendResult[]): SocialTrendResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function tiktokFreshness(value: SearchSocialTrendsInput["freshness"]): string {
  switch (value) {
    case "day": return "yesterday";
    case "week": return "this-week";
    case "month": return "this-month";
    case "year": return "all-time";
    default: return "this-month";
  }
}

function instagramFreshness(value: SearchSocialTrendsInput["freshness"]): string {
  switch (value) {
    case "day": return "last-day";
    case "week": return "last-week";
    case "month": return "last-month";
    case "year": return "last-year";
    default: return "last-month";
  }
}

function redditFreshness(value: SearchSocialTrendsInput["freshness"]): string {
  switch (value) {
    case "day": return "day";
    case "week": return "week";
    case "month": return "month";
    case "year": return "year";
    default: return "month";
  }
}

function tiktokSort(value: SearchSocialTrendsInput["sort"]): string {
  switch (value) {
    case "recent": return "date-posted";
    case "engagement": return "most-liked";
    default: return "relevance";
  }
}

function redditSort(value: SearchSocialTrendsInput["sort"]): string {
  switch (value) {
    case "recent": return "new";
    case "engagement": return "top";
    default: return "relevance";
  }
}

function dateWindowParams(freshness: SearchSocialTrendsInput["freshness"]): Record<string, string> {
  const days = freshness === "day" ? 1 : freshness === "week" ? 7 : freshness === "year" ? 365 : 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

function extractHandle(query: string): string | undefined {
  const match = query.match(/@([A-Za-z0-9_]{1,30})/);
  return match?.[1];
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm)(\?|$)/i.test(url)
    || /tiktok\.com\/@[^/]+\/video\//i.test(url)
    || /instagram\.com\/(reel|p)\//i.test(url)
    || /x\.com\/[^/]+\/status\//i.test(url);
}
