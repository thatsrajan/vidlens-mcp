import { execa } from "execa";
import { fetchWithTimeout } from "./fetch-timeout.js";
import {
  buildChannelUrl,
  buildPlaylistUrl,
  buildVideoUrl,
  type ChannelRef,
} from "./id-parsing.js";
import { parseDescriptionChapters } from "./analysis.js";
import type {
  ChannelRecord,
  CommentRecord,
  SearchItem,
  TranscriptRecord,
  TranscriptSegment,
  VideoRecord,
} from "./types.js";

interface YtDlpSubtitleTrack {
  ext?: string;
  url?: string;
  language?: string;
  name?: string;
}

interface YtDlpVideoJson {
  id?: string;
  title?: string;
  description?: string;
  channel_id?: string;
  channel?: string;
  uploader?: string;
  uploader_id?: string;
  channel_url?: string;
  uploader_url?: string;
  webpage_url?: string;
  upload_date?: string;
  duration?: number;
  duration_string?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  tags?: string[];
  comments?: Array<{
    id?: string;
    author?: string;
    text?: string;
    like_count?: number;
    timestamp?: number;
    parent?: string;
  }>;
  subtitles?: Record<string, YtDlpSubtitleTrack[]>;
  automatic_captions?: Record<string, YtDlpSubtitleTrack[]>;
  entries?: YtDlpVideoJson[];
  channel_follower_count?: number;
  channel_is_verified?: boolean;
  playlist_count?: number;
}

export class YtDlpClient {
  constructor(private readonly binary = "yt-dlp") {}

  getBinary(): string {
    return this.binary;
  }

  async probe(): Promise<{ binary: string; version: string }> {
    try {
      const { stdout } = await execa(this.binary, ["--version"], {
        timeout: 30_000,
        reject: true,
      });
      return {
        binary: this.binary,
        version: stdout.trim(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`yt-dlp probe failed: ${message}`);
    }
  }

  private async runJson(args: string[]): Promise<YtDlpVideoJson> {
    try {
      const { stdout } = await execa(this.binary, args, {
        timeout: 90_000,
        reject: true,
      });
      return JSON.parse(stdout) as YtDlpVideoJson;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`yt-dlp execution failed: ${message}`);
    }
  }

  async search(query: string, maxResults: number): Promise<SearchItem[]> {
    const payload = await this.runJson([
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      `ytsearch${Math.max(1, maxResults)}:${query}`,
    ]);

    const items: SearchItem[] = [];
    for (const entry of payload.entries ?? []) {
      if (!entry.id) {
        continue;
      }
      items.push({
        videoId: entry.id,
        title: entry.title ?? "Untitled video",
        description: entry.description,
        channelId: entry.channel_id ?? entry.uploader_id,
        channelTitle: entry.channel ?? entry.uploader ?? "Unknown channel",
        publishedAt: normalizeUploadDate(entry.upload_date),
        durationSec: entry.duration,
        views: entry.view_count,
        likes: entry.like_count,
        comments: entry.comment_count,
        tags: entry.tags,
        url: entry.webpage_url ?? buildVideoUrl(entry.id),
      });
    }

    return items;
  }

  async videoInfo(videoIdOrUrl: string): Promise<VideoRecord> {
    const payload = await this.runJson([
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      videoIdOrUrl.startsWith("http") ? videoIdOrUrl : buildVideoUrl(videoIdOrUrl),
    ]);

    const videoId = payload.id ?? videoIdOrUrl;
    return {
      videoId,
      title: payload.title ?? "Untitled video",
      description: payload.description,
      channelId: payload.channel_id ?? payload.uploader_id,
      channelTitle: payload.channel ?? payload.uploader ?? "Unknown channel",
      publishedAt: normalizeUploadDate(payload.upload_date),
      durationSec: payload.duration ?? parseDurationString(payload.duration_string),
      views: payload.view_count,
      likes: payload.like_count,
      comments: payload.comment_count,
      tags: payload.tags,
      chapters: parseDescriptionChapters(payload.description),
      transcriptAvailable: Boolean(payload.subtitles || payload.automatic_captions),
      transcriptLanguages: [
        ...Object.keys(payload.subtitles ?? {}),
        ...Object.keys(payload.automatic_captions ?? {}),
      ].filter((value, index, list) => value && list.indexOf(value) === index),
      url: payload.webpage_url ?? buildVideoUrl(videoId),
    };
  }

  async comments(videoId: string, maxResults: number): Promise<CommentRecord[]> {
    const payload = await this.runJson(buildCommentsArgs(buildVideoUrl(videoId), maxResults));

    return (payload.comments ?? [])
      .filter((item) => item.text)
      .slice(0, maxResults)
      .map((item) => ({
        commentId: item.id,
        author: item.author ?? "Unknown author",
        text: item.text ?? "",
        likeCount: item.like_count,
        publishedAt: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : undefined,
      }));
  }

  async channel(ref: ChannelRef): Promise<ChannelRecord> {
    const payload = await this.runJson([
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      "10",
      "--no-warnings",
      "--skip-download",
      buildChannelUrl(ref),
    ]);

    const channelId = payload.channel_id ?? payload.uploader_id;
    if (!channelId) {
      throw new Error("yt-dlp could not resolve channel metadata");
    }

    return {
      channelId,
      title: payload.channel ?? payload.uploader ?? payload.title ?? "Unknown channel",
      description: payload.description,
      descriptionSummary: payload.description?.replace(/\s+/g, " ").trim().slice(0, 220),
      subscribers: payload.channel_follower_count,
      totalVideos: payload.playlist_count ?? payload.entries?.length,
      url: payload.channel_url ?? payload.uploader_url ?? buildChannelUrl(ref),
    };
  }

  async channelVideos(ref: ChannelRef, maxResults: number): Promise<VideoRecord[]> {
    const payload = await this.runJson([
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      String(Math.max(1, maxResults)),
      "--no-warnings",
      "--skip-download",
      buildChannelUrl(ref),
    ]);

    const items: VideoRecord[] = [];
    for (const entry of payload.entries ?? []) {
      if (!entry.id) {
        continue;
      }
      items.push({
        videoId: entry.id,
        title: entry.title ?? "Untitled video",
        channelId: payload.channel_id ?? payload.uploader_id,
        channelTitle: entry.channel ?? entry.uploader ?? payload.channel ?? payload.uploader ?? "Unknown channel",
        publishedAt: normalizeUploadDate(entry.upload_date),
        durationSec: entry.duration,
        views: entry.view_count,
        likes: entry.like_count,
        comments: entry.comment_count,
        tags: entry.tags,
        url: entry.webpage_url ?? buildVideoUrl(entry.id),
        transcriptAvailable: false,
        transcriptLanguages: [],
      });
    }

    return items;
  }

  async playlist(playlistIdOrUrl: string, maxVideos: number): Promise<{
    playlistId: string;
    title?: string;
    channelTitle?: string;
    videoCountReported?: number;
    videos: VideoRecord[];
  }> {
    const url = playlistIdOrUrl.startsWith("http") ? playlistIdOrUrl : buildPlaylistUrl(playlistIdOrUrl);
    const payload = await this.runJson([
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      String(Math.max(1, maxVideos)),
      "--no-warnings",
      "--skip-download",
      url,
    ]);

    return {
      playlistId: payload.id ?? playlistIdOrUrl,
      title: payload.title,
      channelTitle: payload.channel ?? payload.uploader,
      videoCountReported: payload.playlist_count ?? payload.entries?.length,
      videos: (() => {
        const items: VideoRecord[] = [];
        for (const entry of payload.entries ?? []) {
          if (!entry.id) {
            continue;
          }
          items.push({
            videoId: entry.id,
            title: entry.title ?? "Untitled video",
            channelId: entry.channel_id ?? payload.channel_id ?? entry.uploader_id,
            channelTitle: entry.channel ?? entry.uploader ?? payload.channel ?? payload.uploader ?? "Unknown channel",
            publishedAt: normalizeUploadDate(entry.upload_date),
            durationSec: entry.duration,
            views: entry.view_count,
            likes: entry.like_count,
            comments: entry.comment_count,
            tags: entry.tags,
            url: entry.webpage_url ?? buildVideoUrl(entry.id),
            transcriptAvailable: false,
            transcriptLanguages: [],
          });
        }
        return items;
      })(),
    };
  }

  async transcript(videoId: string, languageHint?: string): Promise<TranscriptRecord> {
    const payload = await this.runJson([
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      buildVideoUrl(videoId),
    ]);

    const pickTrack = (
      sourceType: "manual_caption" | "auto_caption",
      tracks: Record<string, YtDlpSubtitleTrack[]> | undefined,
    ):
      | { sourceType: "manual_caption" | "auto_caption"; language: string; track: YtDlpSubtitleTrack }
      | null => {
      if (!tracks) {
        return null;
      }

      const candidateLanguages = [languageHint, "en", "en-US", "en-GB"].filter(
        (value): value is string => Boolean(value),
      );

      for (const language of candidateLanguages) {
        const list = tracks[language] ?? tracks[language.toLowerCase()];
        if (list && list.length > 0) {
          return { sourceType, language, track: list[0] };
        }
      }

      const fallbackLanguage = Object.keys(tracks)[0];
      const fallbackTrack = fallbackLanguage ? tracks[fallbackLanguage]?.[0] : undefined;
      if (fallbackLanguage && fallbackTrack) {
        return { sourceType, language: fallbackLanguage, track: fallbackTrack };
      }

      return null;
    };

    const picked =
      pickTrack("manual_caption", payload.subtitles) ??
      pickTrack("auto_caption", payload.automatic_captions);

    if (!picked?.track?.url) {
      throw new Error("No subtitle or automatic caption track available from yt-dlp metadata");
    }

    const response = await fetchWithTimeout(picked.track.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch subtitle track: HTTP ${response.status}`);
    }

    const rawTranscript = await response.text();
    const parsed = parseSubtitleContent(rawTranscript);
    if (parsed.segments.length === 0) {
      throw new Error("Subtitle file parsed successfully but contained no usable transcript text");
    }

    return {
      videoId: payload.id ?? videoId,
      languageUsed: picked.language,
      sourceType: picked.sourceType === "manual_caption" ? "manual_caption" : "auto_caption",
      confidence: picked.sourceType === "manual_caption" ? 0.92 : 0.68,
      transcriptText: parsed.text,
      segments: parsed.segments,
      chapters: parseDescriptionChapters(payload.description),
    };
  }
}

/**
 * Builds the yt-dlp argv for comment extraction.
 *
 * `--write-comments` (aka --get-comments) is what actually enables comment
 * extraction; the `youtube:max_comments` extractor-arg only caps a run that this
 * flag turns on. Without the flag, payload.comments is always undefined.
 */
export function buildCommentsArgs(videoUrl: string, maxResults: number): string[] {
  const limit = Math.max(maxResults, 1);
  return [
    "--dump-single-json",
    "--no-warnings",
    "--skip-download",
    "--write-comments",
    "--extractor-args",
    `youtube:max_comments=${limit}`,
    videoUrl,
  ];
}

function parseSubtitleContent(input: string): { text: string; segments: TranscriptSegment[] } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { text: "", segments: [] };
  }

  if (trimmed.startsWith("{")) {
    return parseJson3(trimmed);
  }

  return parseVtt(trimmed);
}

function parseJson3(input: string): { text: string; segments: TranscriptSegment[] } {
  type Json3 = {
    events?: Array<{
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    }>;
  };

  let json: Json3;
  try {
    json = JSON.parse(input) as Json3;
  } catch {
    return { text: "", segments: [] };
  }

  const segments: TranscriptSegment[] = [];
  for (const event of json.events ?? []) {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }
    const tStartSec = event.tStartMs ? event.tStartMs / 1000 : 0;
    const durationSec = event.dDurationMs ? event.dDurationMs / 1000 : undefined;
    segments.push({
      tStartSec,
      tEndSec: durationSec !== undefined ? tStartSec + durationSec : undefined,
      text,
    });
  }

  return {
    text: segments.map((segment) => segment.text).join(" ").trim(),
    segments,
  };
}

function parseVtt(input: string): { text: string; segments: TranscriptSegment[] } {
  const lines = input.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  let currentText: string[] = [];

  const flush = (): void => {
    const text = currentText.join(" ").replace(/\s+/g, " ").trim();
    if (text && currentStart !== undefined) {
      segments.push({
        tStartSec: currentStart,
        tEndSec: currentEnd,
        text,
      });
    }
    currentText = [];
    currentStart = undefined;
    currentEnd = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT" || line.startsWith("NOTE")) {
      flush();
      continue;
    }

    if (/^\d+$/.test(line)) {
      continue;
    }

    if (line.includes("-->") && line.includes(":")) {
      flush();
      const [startRaw, endRaw] = line.split("-->").map((part) => part.trim());
      currentStart = parseTimestampSeconds(startRaw);
      currentEnd = parseTimestampSeconds(endRaw);
      continue;
    }

    currentText.push(line.replace(/<[^>]+>/g, ""));
  }

  flush();

  return {
    text: segments.map((segment) => segment.text).join(" ").trim(),
    segments,
  };
}

function parseTimestampSeconds(raw: string): number | undefined {
  const normalized = raw.split(" ")[0].replace(",", ".");
  const parts = normalized.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) {
    return undefined;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return undefined;
}

function normalizeUploadDate(value?: string): string | undefined {
  if (!value || !/^\d{8}$/.test(value)) {
    return value;
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`;
}

function parseDurationString(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) {
    return undefined;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0];
}
