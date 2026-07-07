import { buildChannelUrl, buildVideoUrl, type ChannelRef } from "./id-parsing.js";
import type { ChannelRecord, VideoRecord } from "./types.js";
import { assertPublicHttpUrl } from "./url-guard.js";

export class PageExtractClient {
  async getVideoInfo(videoId: string): Promise<VideoRecord> {
    const html = await this.fetchHtml(buildVideoUrl(videoId));
    const title = readMeta(html, "og:title") ?? readMeta(html, "title");
    const description = readMeta(html, "og:description") ?? undefined;
    const publishedAt = readMeta(html, "datePublished") ?? undefined;
    const channelTitle =
      readJsonField(html, /"ownerChannelName":"([^"]+)"/) ??
      readJsonField(html, /"author":"([^"]+)"/) ??
      "Unknown channel";
    const channelId = readJsonField(html, /"channelId":"([^"]+)"/);
    const viewCount = readNumberField(html, /"interactionCount":"(\d+)"/);
    const durationSec = parseDurationSeconds(readMeta(html, "duration") ?? undefined);

    if (!title) {
      throw new Error("Could not extract video metadata from watch page");
    }

    return {
      videoId,
      title,
      channelId,
      channelTitle,
      publishedAt,
      durationSec,
      views: viewCount,
      description,
      url: buildVideoUrl(videoId),
      transcriptAvailable: false,
      transcriptLanguages: [],
    };
  }

  async getChannelInfo(ref: ChannelRef): Promise<ChannelRecord> {
    const url = buildChannelUrl(ref);
    const html = await this.fetchHtml(url);
    const title = readMeta(html, "og:title") ?? readJsonField(html, /"title":"([^"]+)"/);
    const description = readMeta(html, "og:description") ?? undefined;
    const channelId =
      readJsonField(html, /"externalId":"([^"]+)"/) ??
      readJsonField(html, /"channelId":"([^"]+)"/);
    const subscriberText = readJsonField(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText":"([^"]+)"/);

    if (!title || !channelId) {
      throw new Error("Could not extract channel metadata from public page");
    }

    return {
      channelId,
      title,
      description,
      descriptionSummary: description?.slice(0, 220),
      subscribers: parseHumanCount(subscriberText),
      url,
    };
  }

  private async fetchHtml(url: string): Promise<string> {
    // SSRF guard: a channel ref can carry an arbitrary URL (parseChannelRef
    // passes non-YouTube URLs verbatim), so refuse internal/metadata targets.
    assertPublicHttpUrl(url);
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      throw new Error(`Public page fetch failed (${response.status})`);
    }

    return response.text();
  }
}

function readMeta(html: string, name: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+itemprop=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtml(match[1]);
    }
  }

  return undefined;
}

function readJsonField(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern);
  return match?.[1] ? decodeHtml(match[1]) : undefined;
}

function readNumberField(html: string, pattern: RegExp): number | undefined {
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function parseDurationSeconds(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseHumanCount(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase().replace(/subscribers?|,/g, "").trim();
  const match = normalized.match(/([\d.]+)\s*([kmb])?/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "b" ? 1_000_000_000 : suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
