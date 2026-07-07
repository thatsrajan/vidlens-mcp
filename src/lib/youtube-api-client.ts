import { buildChannelUrl, buildPlaylistUrl, buildVideoUrl, type ChannelRef } from "./id-parsing.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import type { ChannelRecord, CommentRecord, SearchItem, VideoRecord } from "./types.js";

/** YouTube Data API caps most list endpoints at 50 items per request. */
const API_PAGE_SIZE = 50;

interface ApiConfig {
  apiKey?: string;
}

interface ApiRequestParams {
  [key: string]: string | number | undefined;
}

interface SearchVideosOptions {
  maxResults: number;
  order?: "relevance" | "date" | "viewCount" | "rating";
  regionCode?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  channelId?: string;
  duration?: "any" | "short" | "medium" | "long";
}

export class YouTubeApiClient {
  private readonly apiKey?: string;
  private readonly baseUrl = "https://www.googleapis.com/youtube/v3";

  constructor(config: ApiConfig) {
    this.apiKey = config.apiKey;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async request<T>(path: string, params: ApiRequestParams): Promise<T> {
    if (!this.apiKey) {
      throw new Error("YOUTUBE_API_KEY is not configured");
    }

    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set("key", this.apiKey);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YouTube API request failed (${response.status}): ${body}`);
    }

    return (await response.json()) as T;
  }

  async searchVideos(query: string, options: SearchVideosOptions): Promise<SearchItem[]> {
    type SearchResponse = {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: {
          title?: string;
          description?: string;
          channelId?: string;
          channelTitle?: string;
          publishedAt?: string;
        };
      }>;
    };

    const search = await this.request<SearchResponse>("search", {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: options.maxResults,
      order: options.order,
      regionCode: options.regionCode,
      publishedAfter: options.publishedAfter,
      publishedBefore: options.publishedBefore,
      channelId: options.channelId,
      videoDuration: options.duration && options.duration !== "any" ? options.duration : undefined,
    });

    const ids = (search.items ?? [])
      .map((item) => item.id?.videoId)
      .filter((id): id is string => Boolean(id));

    const details = ids.length > 0 ? await this.getVideosByIds(ids) : [];
    const detailsById = new Map(details.map((item) => [item.videoId, item]));

    const items: SearchItem[] = [];
    for (const item of search.items ?? []) {
      const videoId = item.id?.videoId;
      if (!videoId) {
        continue;
      }
      const detail = detailsById.get(videoId);
      items.push({
        videoId,
        title: item.snippet?.title ?? detail?.title ?? "Untitled video",
        description: item.snippet?.description ?? detail?.description,
        channelId: item.snippet?.channelId ?? detail?.channelId,
        channelTitle: item.snippet?.channelTitle ?? detail?.channelTitle ?? "Unknown channel",
        publishedAt: item.snippet?.publishedAt ?? detail?.publishedAt,
        durationSec: detail?.durationSec,
        views: detail?.views,
        likes: detail?.likes,
        comments: detail?.comments,
        tags: detail?.tags,
        url: buildVideoUrl(videoId),
      });
    }

    return items;
  }

  async getVideoInfo(videoId: string): Promise<VideoRecord> {
    const [record] = await this.getVideosByIds([videoId]);
    if (!record) {
      throw new Error(`Video not found: ${videoId}`);
    }
    return record;
  }

  async getVideosByIds(videoIds: string[]): Promise<VideoRecord[]> {
    if (videoIds.length === 0) {
      return [];
    }

    type VideosResponse = {
      items?: Array<{
        id?: string;
        snippet?: {
          title?: string;
          description?: string;
          channelId?: string;
          channelTitle?: string;
          publishedAt?: string;
          tags?: string[];
          defaultAudioLanguage?: string;
          categoryId?: string;
        };
        contentDetails?: {
          duration?: string;
          caption?: string;
        };
        statistics?: {
          viewCount?: string;
          likeCount?: string;
          commentCount?: string;
        };
      }>;
    };

    // The videos endpoint accepts at most 50 ids per request; batch to stay
    // under the cap now that callers can pass more (paginated playlists).
    const rawVideos: NonNullable<VideosResponse["items"]> = [];
    for (let offset = 0; offset < videoIds.length; offset += API_PAGE_SIZE) {
      const batch = videoIds.slice(offset, offset + API_PAGE_SIZE);
      const response = await this.request<VideosResponse>("videos", {
        part: "snippet,contentDetails,statistics",
        id: batch.join(","),
        maxResults: batch.length,
      });
      rawVideos.push(...(response.items ?? []));
    }

    const items: VideoRecord[] = [];
    for (const video of rawVideos) {
      if (!video.id) {
        continue;
      }
      items.push({
        videoId: video.id,
        title: video.snippet?.title ?? "Untitled video",
        description: video.snippet?.description,
        channelId: video.snippet?.channelId,
        channelTitle: video.snippet?.channelTitle ?? "Unknown channel",
        publishedAt: video.snippet?.publishedAt,
        durationSec: parseIsoDurationToSeconds(video.contentDetails?.duration),
        views: parseCount(video.statistics?.viewCount),
        likes: parseCount(video.statistics?.likeCount),
        comments: parseCount(video.statistics?.commentCount),
        tags: video.snippet?.tags,
        language: video.snippet?.defaultAudioLanguage,
        category: video.snippet?.categoryId,
        transcriptAvailable: video.contentDetails?.caption === "true",
        transcriptLanguages: video.contentDetails?.caption === "true" ? [video.snippet?.defaultAudioLanguage ?? "unknown"] : [],
        url: buildVideoUrl(video.id),
      });
    }

    return items;
  }

  async getVideoComments(
    videoId: string,
    maxResults: number,
    order: "relevance" | "time" = "relevance",
    includeReplies = false,
    maxRepliesPerThread = 3,
  ): Promise<CommentRecord[]> {
    type CommentsResponse = {
      nextPageToken?: string;
      items?: Array<{
        id?: string;
        snippet?: {
          totalReplyCount?: number;
          topLevelComment?: {
            snippet?: {
              authorDisplayName?: string;
              textDisplay?: string;
              likeCount?: number;
              publishedAt?: string;
            };
          };
        };
        replies?: {
          comments?: Array<{
            id?: string;
            snippet?: {
              authorDisplayName?: string;
              textDisplay?: string;
              likeCount?: number;
              publishedAt?: string;
            };
          }>;
        };
      }>;
    };

    const comments: CommentRecord[] = [];
    let pageToken: string | undefined;

    // commentThreads caps each request at 100 items; page until we reach the
    // requested count (the service advertises up to 200) or run out of pages.
    while (comments.length < maxResults) {
      const response = await this.request<CommentsResponse>("commentThreads", {
        part: includeReplies ? "snippet,replies" : "snippet",
        videoId,
        maxResults: Math.min(maxResults - comments.length, 100),
        order,
        textFormat: "plainText",
        pageToken,
      });

      for (const item of response.items ?? []) {
        const snippet = item.snippet?.topLevelComment?.snippet;
        if (!snippet?.textDisplay) {
          continue;
        }
        comments.push({
          commentId: item.id,
          author: snippet.authorDisplayName ?? "Unknown author",
          text: snippet.textDisplay,
          likeCount: snippet.likeCount,
          publishedAt: snippet.publishedAt,
          replies: includeReplies
            ? (item.replies?.comments ?? [])
                .slice(0, maxRepliesPerThread)
                .map((reply) => ({
                  commentId: reply.id,
                  author: reply.snippet?.authorDisplayName ?? "Unknown author",
                  text: reply.snippet?.textDisplay ?? "",
                  likeCount: reply.snippet?.likeCount,
                  publishedAt: reply.snippet?.publishedAt,
                }))
                .filter((reply) => reply.text)
            : undefined,
        });
        if (comments.length >= maxResults) {
          break;
        }
      }

      pageToken = response.nextPageToken;
      if (!pageToken || (response.items ?? []).length === 0) {
        break;
      }
    }

    return comments.slice(0, maxResults);
  }

  async getChannel(ref: ChannelRef): Promise<ChannelRecord> {
    type ChannelResponse = {
      items?: Array<{
        id?: string;
        snippet?: {
          title?: string;
          description?: string;
          customUrl?: string;
          publishedAt?: string;
          country?: string;
        };
        statistics?: {
          subscriberCount?: string;
          videoCount?: string;
          viewCount?: string;
        };
        contentDetails?: {
          relatedPlaylists?: {
            uploads?: string;
          };
        };
      }>;
    };

    let response: ChannelResponse | null = null;

    if (ref.type === "id") {
      response = await this.request<ChannelResponse>("channels", {
        part: "snippet,statistics,contentDetails",
        id: ref.value,
        maxResults: 1,
      });
    } else if (ref.type === "handle") {
      response = await this.request<ChannelResponse>("channels", {
        part: "snippet,statistics,contentDetails",
        forHandle: ref.value,
        maxResults: 1,
      });
    } else {
      type SearchResponse = { items?: Array<{ id?: { channelId?: string } }> };
      const search = await this.request<SearchResponse>("search", {
        part: "snippet",
        type: "channel",
        q: ref.value,
        maxResults: 1,
      });
      const channelId = search.items?.[0]?.id?.channelId;
      if (!channelId) {
        throw new Error(`Could not resolve channel for input: ${ref.value}`);
      }
      response = await this.request<ChannelResponse>("channels", {
        part: "snippet,statistics,contentDetails",
        id: channelId,
        maxResults: 1,
      });
    }

    const channel = response.items?.[0];
    if (!channel?.id) {
      throw new Error(`Channel not found for input: ${ref.value}`);
    }

    return {
      channelId: channel.id,
      title: channel.snippet?.title ?? "Unknown channel",
      handle: channel.snippet?.customUrl?.replace(/^@/, ""),
      createdAt: channel.snippet?.publishedAt,
      country: channel.snippet?.country,
      description: channel.snippet?.description,
      descriptionSummary: summarizeDescription(channel.snippet?.description),
      subscribers: parseCount(channel.statistics?.subscriberCount),
      totalViews: parseCount(channel.statistics?.viewCount),
      totalVideos: parseCount(channel.statistics?.videoCount),
      uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
      url: buildChannelUrl({ type: "id", value: channel.id }),
    };
  }

  async listChannelVideos(channelRef: ChannelRef, maxResults: number): Promise<VideoRecord[]> {
    const channel = await this.getChannel(channelRef);
    const uploadsPlaylistId = channel.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      throw new Error(`Uploads playlist not available for channel ${channel.channelId}`);
    }

    return this.getPlaylistVideos(uploadsPlaylistId, maxResults);
  }

  async getPlaylistVideos(playlistId: string, maxResults: number): Promise<VideoRecord[]> {
    type PlaylistItemsResponse = {
      nextPageToken?: string;
      items?: Array<{
        snippet?: {
          title?: string;
          channelTitle?: string;
          publishedAt?: string;
          resourceId?: { videoId?: string };
        };
      }>;
    };

    const ids: string[] = [];
    let pageToken: string | undefined;

    // playlistItems caps each request at 50; page until we reach the requested
    // count (the service advertises up to 200) or run out of pages.
    while (ids.length < maxResults) {
      const response = await this.request<PlaylistItemsResponse>("playlistItems", {
        part: "snippet",
        playlistId,
        maxResults: Math.min(maxResults - ids.length, API_PAGE_SIZE),
        pageToken,
      });

      for (const item of response.items ?? []) {
        const videoId = item.snippet?.resourceId?.videoId;
        if (videoId) {
          ids.push(videoId);
        }
        if (ids.length >= maxResults) {
          break;
        }
      }

      pageToken = response.nextPageToken;
      if (!pageToken || (response.items ?? []).length === 0) {
        break;
      }
    }

    const details = await this.getVideosByIds(ids);
    const detailMap = new Map(details.map((item) => [item.videoId, item]));

    return ids
      .map((id) => detailMap.get(id))
      .filter((item): item is VideoRecord => Boolean(item));
  }

  async getPlaylistMeta(playlistId: string): Promise<{ playlistId: string; title?: string; channelTitle?: string; videoCountReported?: number; url: string }> {
    type PlaylistResponse = {
      items?: Array<{
        id?: string;
        snippet?: {
          title?: string;
          channelTitle?: string;
        };
        contentDetails?: {
          itemCount?: number;
        };
      }>;
    };

    const response = await this.request<PlaylistResponse>("playlists", {
      part: "snippet,contentDetails",
      id: playlistId,
      maxResults: 1,
    });

    const playlist = response.items?.[0];
    if (!playlist?.id) {
      throw new Error(`Playlist not found: ${playlistId}`);
    }

    return {
      playlistId: playlist.id,
      title: playlist.snippet?.title,
      channelTitle: playlist.snippet?.channelTitle,
      videoCountReported: playlist.contentDetails?.itemCount,
      url: buildPlaylistUrl(playlist.id),
    };
  }
}

function parseIsoDurationToSeconds(value?: string): number | undefined {
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

function parseCount(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function summarizeDescription(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  return input.replace(/\s+/g, " ").trim().slice(0, 220);
}
