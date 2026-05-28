import type { CookieStore } from "../auth/cookie-store.js";
import type { MediaStore, MediaAsset } from "../media-store.js";
import type { ProgressReporter } from "../progress.js";
import type { SttProvider } from "../stt/types.js";
import type {
  CommentRecord,
  SearchItem,
  TranscriptRecord,
  VideoSourceCapabilities,
  VideoSourcePlatform,
} from "../types.js";
import type { VideoSourceRef } from "../video-source.js";
import type { WebSearchProvider } from "../web-search/types.js";

export interface ProviderContext {
  ytDlpBinary: string;
  mediaStore: MediaStore;
  dataDir: string;
  cookieStore: CookieStore;
  webSearch?: WebSearchProvider | null;
  stt?: SttProvider | null;
  progressReporter?: ProgressReporter;
  env: NodeJS.ProcessEnv;
}

export interface ProviderInspectResult {
  source: VideoSourceRef;
  capabilities: VideoSourceCapabilities;
  notes: string[];
}

export interface ProviderDownloadOptions {
  format: "best_video" | "worst_video" | "best_audio" | "thumbnail";
  maxSizeMb?: number;
}

export interface ProviderDownloadResult {
  asset: MediaAsset;
  downloadedBytes: number;
  durationMs: number;
}

export interface ProviderTranscribeOptions {
  language?: string;
}

export interface ProviderSearchOptions {
  maxResults?: number;
}

export interface VideoProvider {
  readonly platform: VideoSourcePlatform;
  capabilities(ctx: ProviderContext): VideoSourceCapabilities;
  inspect(ref: VideoSourceRef, ctx: ProviderContext): Promise<ProviderInspectResult>;
  download(ref: VideoSourceRef, opts: ProviderDownloadOptions, ctx: ProviderContext): Promise<ProviderDownloadResult>;
  transcribe?(ref: VideoSourceRef, opts: ProviderTranscribeOptions, ctx: ProviderContext): Promise<TranscriptRecord>;
  comments?(ref: VideoSourceRef, ctx: ProviderContext): Promise<CommentRecord[]>;
  searchByQuery?(query: string, opts: ProviderSearchOptions, ctx: ProviderContext): Promise<SearchItem[]>;
}
