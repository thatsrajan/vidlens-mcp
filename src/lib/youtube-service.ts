import { writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  average,
  buildChapterTranscriptSegments,
  buildTranscriptSegmentsForWindow,
  computeCommentRate,
  computeEngagementRate,
  computeFormatBreakdown,
  computeLikeRate,
  computeNicheMomentum,
  computeNicheSaturation,
  computeViewVelocity24h,
  detectContentGaps,
  extractRecurringKeywords,
  inferVideoFormat,
  median,
  parseDescriptionChapters,
  percentile,
  scoreHookPattern,
  summarizeText,
  titleStructure,
  analyzeComments,
} from "./analysis.js";
import { CommentKnowledgeBase } from "./comment-knowledge-base.js";
import { CacheStore, buildCacheKey, type CacheEntityType } from "./cache-store.js";
import { createEmbeddingProvider, resolveEmbeddingSelection } from "./embedding-provider.js";
import { detectKnownClients, readPackageMetadata } from "./install-diagnostics.js";
import { TranscriptKnowledgeBase } from "./knowledge-base.js";
import { MediaStore } from "./media-store.js";
import { MediaDownloader } from "./media-downloader.js";
import { ThumbnailExtractor } from "./thumbnail-extractor.js";
import { VisualSearchEngine } from "./visual-search.js";
import {
  parseChannelRef,
  parsePlaylistId,
  parseVideoId,
  type ChannelRef,
} from "./id-parsing.js";
import { PageExtractClient } from "./page-extract-client.js";
import type {
  AnalyzePlaylistInput,
  AnalyzePlaylistOutput,
  AnalyzeVideoSetInput,
  AnalyzeVideoSetItem,
  AnalyzeVideoSetOutput,
  BuildVideoDossierInput,
  BuildVideoDossierOutput,
  ChannelRecord,
  CheckImportReadinessInput,
  CheckImportReadinessOutput,
  CheckSystemHealthInput,
  CheckSystemHealthOutput,
  ClearActiveCollectionOutput,
  ClearActiveCommentCollectionOutput,
  ClientDetectionSummary,
  CommentRecord,
  CompareShortsVsLongInput,
  CompareShortsVsLongOutput,
  DiagnosticCheck,
  DiscoverNicheTrendsInput,
  DiscoverNicheTrendsOutput,
  DownloadAssetInput,
  DownloadAssetOutput,
  ExpandPlaylistInput,
  ExpandPlaylistOutput,
  ExploreNicheCompetitorsInput,
  ExploreNicheCompetitorsOutput,
  ExploreYouTubeInput,
  ExploreYouTubeOutput,
  ExtractKeyframesInput,
  ExtractKeyframesOutput,
  FindSimilarFramesInput,
  FindSimilarFramesOutput,
  FindVideosInput,
  FindVideosOutput,
  GracefulError,
  ImportCommentsInput,
  ImportCommentsOutput,
  ImportPlaylistOutput,
  ImportVideosOutput,
  IndexVisualContentInput,
  IndexVisualContentOutput,
  InspectChannelInput,
  InspectChannelOutput,
  InspectVideoInput,
  InspectVideoOutput,
  ListChannelCatalogInput,
  ListChannelCatalogOutput,
  ListCollectionsInput,
  ListCollectionsOutput,
  ListCommentCollectionsInput,
  ListCommentCollectionsOutput,
  ListMediaAssetsInput,
  ListMediaAssetsOutput,
  MeasureAudienceSentimentInput,
  MeasureAudienceSentimentOutput,
  MediaStoreHealthOutput,
  NicheCompetitor,
  Pagination,
  PlaylistKnowledgeBaseInput,
  Provenance,
  ReadCommentsInput,
  ReadCommentsOutput,
  ReadTranscriptInput,
  ReadTranscriptOutput,
  RecommendUploadWindowsInput,
  RecommendUploadWindowsOutput,
  RemoveCollectionInput,
  RemoveCollectionOutput,
  RemoveCommentCollectionInput,
  RemoveCommentCollectionOutput,
  RemoveMediaAssetInput,
  RemoveMediaAssetOutput,
  ResearchTagsAndTitlesInput,
  ResearchTagsAndTitlesOutput,
  SearchItem,
  ScoreHookPatternsInput,
  ScoreHookPatternsOutput,
  SearchCommentsInput,
  SearchCommentsOutput,
  SearchTranscriptsInput,
  SearchTranscriptsOutput,
  SearchVisualContentInput,
  SearchVisualContentOutput,
  ServiceOptions,
  SetActiveCollectionInput,
  SetActiveCollectionOutput,
  SetActiveCommentCollectionInput,
  SetActiveCommentCollectionOutput,
  SourceTier,
  TranscriptRecord,
  TrendingVideo,
  VideoAnalysisMode,
  VideoKnowledgeBaseInput,
  VideoRecord,
} from "./types.js";
import { YouTubeApiClient } from "./youtube-api-client.js";
import { YtDlpClient } from "./ytdlp-client.js";

interface YouTubeServiceConfig {
  apiKey?: string;
  dryRun?: boolean;
  ytDlpBinary?: string;
  dataDir?: string;
}

class ToolExecutionError extends Error {
  constructor(readonly detail: GracefulError) {
    super(detail.message);
    this.name = "ToolExecutionError";
  }
}

const FALLBACK_DEPTH: Record<SourceTier, 0 | 1 | 2 | 3> = {
  youtube_api: 0,
  yt_dlp: 1,
  page_extract: 2,
  none: 3,
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function defaultServiceDataDir(): string {
  return process.env.VIDLENS_DATA_DIR || join(homedir(), "Library", "Application Support", "vidlens-mcp");
}

export class YouTubeService {
  private readonly api: YouTubeApiClient;
  private readonly ytdlp: YtDlpClient;
  private readonly pageExtract: PageExtractClient;
  private readonly dryRun: boolean;
  private readonly dataDir: string;
  private readonly ytDlpBinary?: string;
  private _knowledgeBase?: TranscriptKnowledgeBase;
  private _commentKnowledgeBase?: CommentKnowledgeBase;
  private _mediaStore?: MediaStore;
  private _mediaDownloader?: MediaDownloader;
  private _thumbnailExtractor?: ThumbnailExtractor;
  private _visualSearch?: VisualSearchEngine;
  private _cacheStore?: CacheStore;

  constructor(config: YouTubeServiceConfig = {}) {
    this.api = new YouTubeApiClient({ apiKey: config.apiKey ?? process.env.YOUTUBE_API_KEY });
    this.ytdlp = new YtDlpClient(config.ytDlpBinary);
    this.pageExtract = new PageExtractClient();
    this.dryRun = Boolean(config.dryRun);
    this.dataDir = config.dataDir ?? defaultServiceDataDir();
    this.ytDlpBinary = config.ytDlpBinary;
  }

  private get knowledgeBase(): TranscriptKnowledgeBase {
    return this._knowledgeBase ??= new TranscriptKnowledgeBase({ dataDir: this.dataDir });
  }

  private get commentKnowledgeBase(): CommentKnowledgeBase {
    return this._commentKnowledgeBase ??= new CommentKnowledgeBase({ dataDir: this.dataDir });
  }

  private get mediaStore(): MediaStore {
    return this._mediaStore ??= new MediaStore({ dataDir: this.dataDir });
  }

  private get mediaDownloader(): MediaDownloader {
    return this._mediaDownloader ??= new MediaDownloader(this.mediaStore, this.ytDlpBinary);
  }

  private get thumbnailExtractor(): ThumbnailExtractor {
    return this._thumbnailExtractor ??= new ThumbnailExtractor(this.mediaStore);
  }

  private get visualSearch(): VisualSearchEngine {
    return this._visualSearch ??= new VisualSearchEngine(
      this.mediaStore,
      this.mediaDownloader,
      this.thumbnailExtractor,
      { dataDir: this.dataDir },
    );
  }

  private get cacheStore(): CacheStore {
    return this._cacheStore ??= new CacheStore({ dataDir: this.dataDir });
  }

  async findVideos(input: FindVideosInput, options: ServiceOptions = {}): Promise<FindVideosOutput> {
    const query = input.query?.trim();
    if (!query) {
      throw this.invalidInput("Query cannot be empty");
    }

    const maxResults = clamp(input.maxResults ?? 10, 1, 25);
    const resolved = await this.withCache(
      "search",
      "findVideos",
      {
        query,
        maxResults,
        order: input.order ?? null,
        regionCode: input.regionCode ?? null,
        publishedAfter: input.publishedAfter ?? null,
        publishedBefore: input.publishedBefore ?? null,
        channelId: input.channelId ?? null,
        duration: input.duration ?? null,
      },
      options,
      () => this.executeFallback(
        {
          youtube_api: () =>
            this.api.searchVideos(query, {
              maxResults,
              order: input.order,
              regionCode: input.regionCode,
              publishedAfter: input.publishedAfter,
              publishedBefore: input.publishedBefore,
              channelId: input.channelId,
              duration: input.duration,
            }),
          yt_dlp: () => this.ytdlp.search(query, maxResults),
        },
        this.sampleSearch(query, maxResults),
        options,
      ),
    );

    return {
      query,
      results: resolved.data.map((item) => ({
        videoId: item.videoId,
        title: item.title,
        channelId: item.channelId,
        channelTitle: item.channelTitle,
        publishedAt: item.publishedAt,
        durationSec: item.durationSec,
        views: item.views,
        engagementRate: computeEngagementRate(item),
      })),
      provenance: resolved.provenance,
    };
  }

  async inspectVideo(input: InspectVideoInput, options: ServiceOptions = {}): Promise<InspectVideoOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);
    const includeTranscriptMeta = input.includeTranscriptMeta ?? true;
    const includeEngagementRatios = input.includeEngagementRatios ?? true;
    const resolved = await this.resolveVideoInfo(videoId, options);

    const video = resolved.data;

    return {
      video: {
        videoId: video.videoId,
        title: video.title,
        channelId: video.channelId,
        channelTitle: video.channelTitle,
        publishedAt: video.publishedAt,
        durationSec: video.durationSec,
        category: video.category,
        tags: video.tags?.slice(0, 12),
        language: video.language,
      },
      stats: {
        views: video.views,
        likes: video.likes,
        comments: video.comments,
        likeRate: includeEngagementRatios ? computeLikeRate(video) : undefined,
        commentRate: includeEngagementRatios ? computeCommentRate(video) : undefined,
        viewVelocity24h: includeEngagementRatios ? computeViewVelocity24h(video.views, video.publishedAt) : undefined,
      },
      transcriptMeta: includeTranscriptMeta
        ? {
            available: Boolean(video.transcriptAvailable),
            languages: video.transcriptLanguages?.slice(0, 6),
          }
        : undefined,
      provenance: resolved.provenance,
    };
  }

  async inspectChannel(input: InspectChannelInput, options: ServiceOptions = {}): Promise<InspectChannelOutput> {
    const channelRef = this.requireChannelRef(input.channelIdOrHandleOrUrl);
    const resolved = await this.resolveChannel(channelRef, options);

    const cadence = await this.bestEffortChannelCadence(channelRef, options);
    const channel = resolved.data;
    const avgViewsPerVideo = channel.totalViews && channel.totalVideos
      ? Math.round(channel.totalViews / Math.max(channel.totalVideos, 1))
      : undefined;

    const provenance = this.mergeProvenances([
      resolved.provenance,
      cadence.provenance,
    ]);

    return {
      channel: {
        channelId: channel.channelId,
        title: channel.title,
        handle: channel.handle,
        createdAt: channel.createdAt,
        country: channel.country,
        descriptionSummary: channel.descriptionSummary ?? summarizeText(channel.description ?? "", 2),
      },
      stats: {
        subscribers: channel.subscribers,
        totalViews: channel.totalViews,
        totalVideos: channel.totalVideos,
        avgViewsPerVideo,
      },
      cadence: cadence.data,
      provenance,
    };
  }

  async listChannelCatalog(input: ListChannelCatalogInput, options: ServiceOptions = {}): Promise<ListChannelCatalogOutput> {
    const channelRef = this.requireChannelRef(input.channelIdOrHandleOrUrl);
    const maxResults = clamp(input.maxResults ?? 25, 1, 100);

    const channel = await this.resolveChannel(channelRef, options);
    const videos = await this.resolveChannelVideos(channelRef, maxResults, channel.data.channelId, options);

    const filtered = this.filterAndSortCatalog(videos.data, {
      sortBy: input.sortBy,
      includeShorts: input.includeShorts ?? true,
      includeLongForm: input.includeLongForm ?? true,
      publishedWithinDays: input.publishedWithinDays,
    });

    return {
      channelId: channel.data.channelId,
      items: filtered.slice(0, maxResults).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt,
        durationSec: video.durationSec,
        format: inferVideoFormat(video.durationSec),
        views: video.views,
        likes: video.likes,
        comments: video.comments,
      })),
      provenance: this.mergeProvenances([channel.provenance, videos.provenance]),
    };
  }

  async readTranscript(input: ReadTranscriptInput, options: ServiceOptions = {}): Promise<ReadTranscriptOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);
    const requestedMode = input.mode ?? "key_moments";
    const includeTimestamps = input.includeTimestamps ?? true;
    const offset = Math.max(0, input.offset ?? 0);
    const limit = clamp(input.limit ?? 32000, 1000, 64000);
    const chunkWindowSec = clamp(input.chunkWindowSec ?? 120, 30, 900);

    const resolved = await this.resolveTranscript(videoId, input.language, options);

    const transcript = resolved.data;
    const totalCharacters = transcript.transcriptText.length;
    const totalEstimatedTokens = Math.ceil(totalCharacters / 4);
    let mode: ReadTranscriptOutput["transcript"]["mode"] = requestedMode;
    let autoDowngraded = false;
    if (requestedMode === "full" && totalCharacters > 32000 && input.offset === undefined && input.limit === undefined) {
      mode = "key_moments";
      autoDowngraded = true;
    }

    let text: string | undefined;
    let segments: ReadTranscriptOutput["transcript"]["segments"] | undefined;

    if (mode === "full") {
      const chunk = transcript.transcriptText.slice(offset, offset + limit);
      text = chunk;
    } else if (mode === "summary") {
      text = summarizeText(transcript.transcriptText, 4);
      segments = includeTimestamps
        ? buildTranscriptSegmentsForWindow(transcript, chunkWindowSec, 4).map((segment) => ({
            tStartSec: segment.tStartSec,
            tEndSec: segment.tEndSec,
            text: summarizeText(segment.text, 1),
            topicLabel: segment.topicLabel,
          }))
        : undefined;
    } else if (mode === "chapters") {
      segments = buildChapterTranscriptSegments(transcript).map((segment) => ({
        tStartSec: segment.tStartSec,
        tEndSec: segment.tEndSec,
        text: summarizeText(segment.text, 2),
        chapterTitle: segment.chapterTitle,
        topicLabel: segment.topicLabel,
      }));
    } else {
      segments = buildTranscriptSegmentsForWindow(transcript, chunkWindowSec, 6).map((segment) => ({
        tStartSec: segment.tStartSec,
        tEndSec: segment.tEndSec,
        text: summarizeText(segment.text, 2),
        topicLabel: segment.topicLabel,
      }));
    }

    if (!includeTimestamps && segments) {
      segments = segments.map((segment) => ({
        ...segment,
        tStartSec: 0,
        tEndSec: undefined,
      }));
    }

    const pagination =
      mode === "full"
        ? {
            offset,
            limit,
            hasMore: offset + limit < totalCharacters,
            nextOffset: offset + limit < totalCharacters ? offset + limit : undefined,
          }
        : undefined;

    return {
      videoId,
      languageUsed: transcript.languageUsed,
      transcript: {
        mode,
        text,
        segments,
      },
      longVideoHandling: {
        totalCharacters,
        totalEstimatedTokens,
        autoDowngraded,
        originalMode: autoDowngraded ? requestedMode : undefined,
        pagination,
      },
      chapters: (transcript.chapters ?? parseDescriptionChapters(undefined)).slice(0, 20),
      quality: {
        sourceType: transcript.sourceType,
        confidence: transcript.confidence,
      },
      provenance: resolved.provenance,
    };
  }

  async readComments(input: ReadCommentsInput, options: ServiceOptions = {}): Promise<ReadCommentsOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);
    const maxTopLevel = clamp(input.maxTopLevel ?? 50, 1, 200);
    const includeReplies = input.includeReplies ?? false;
    const maxRepliesPerThread = clamp(input.maxRepliesPerThread ?? 3, 0, 20);
    const resolved = await this.resolveComments(
      videoId,
      maxTopLevel,
      input.order ?? "relevance",
      includeReplies,
      maxRepliesPerThread,
      options,
    );

    return {
      videoId,
      totalFetched: resolved.data.length,
      threads: resolved.data.map((thread) => ({
        commentId: thread.commentId,
        author: thread.author,
        text: thread.text,
        likeCount: thread.likeCount,
        publishedAt: thread.publishedAt,
        replies: includeReplies
          ? (thread.replies ?? []).slice(0, maxRepliesPerThread).map((reply) => ({
              commentId: reply.commentId,
              author: reply.author,
              text: reply.text,
              likeCount: reply.likeCount,
              publishedAt: reply.publishedAt,
            }))
          : undefined,
      })),
      provenance: resolved.provenance,
    };
  }

  async measureAudienceSentiment(
    input: MeasureAudienceSentimentInput,
    options: ServiceOptions = {},
  ): Promise<MeasureAudienceSentimentOutput> {
    const comments = await this.readComments(
      {
        videoIdOrUrl: input.videoIdOrUrl,
        maxTopLevel: input.sampleSize ?? 200,
        includeReplies: false,
      },
      options,
    );

    const analysis = analyzeComments(
      comments.threads.map((thread) => ({
        commentId: thread.commentId,
        author: thread.author,
        text: thread.text,
        likeCount: thread.likeCount,
        publishedAt: thread.publishedAt,
      })),
      input.includeThemes ?? true,
      input.includeRepresentativeQuotes ?? true,
    );

    return {
      videoId: comments.videoId,
      sampleSize: comments.totalFetched,
      sentiment: analysis.sentiment,
      themes: analysis.themes,
      riskSignals: analysis.riskSignals,
      representativeQuotes: analysis.representativeQuotes,
      provenance: comments.provenance,
    };
  }

  async analyzeVideoSet(input: AnalyzeVideoSetInput, options: ServiceOptions = {}): Promise<AnalyzeVideoSetOutput> {
    if (!Array.isArray(input.videoIdsOrUrls) || input.videoIdsOrUrls.length === 0) {
      throw this.invalidInput("videoIdsOrUrls must contain at least one video");
    }
    if (!Array.isArray(input.analyses) || input.analyses.length === 0) {
      throw this.invalidInput("analyses must contain at least one analysis mode");
    }

    const items: AnalyzeVideoSetItem[] = [];

    const validInputs: Array<{ raw: string; parsed: string }> = [];
    for (const raw of input.videoIdsOrUrls.slice(0, 20)) {
      const parsed = parseVideoId(raw);
      if (!parsed) {
        items.push({
          videoId: raw,
          analyses: {},
          errors: [this.invalidInputDetail(`Invalid YouTube video reference: ${raw}`)],
          provenance: this.makeProvenance("none", true, ["Input could not be parsed as a YouTube video ID or URL."]),
        });
      } else {
        validInputs.push({ raw, parsed });
      }
    }

    const results = await Promise.allSettled(
      validInputs.map(({ parsed }) =>
        this.analyzeSingleVideo(parsed, input.analyses, {
          commentsSampleSize: input.commentsSampleSize ?? 50,
          transcriptMode: input.transcriptMode ?? "key_moments",
        }, options),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        items.push(result.value);
      }
    }

    const processedCount = items.filter((item) => Object.keys(item.analyses).length > 0).length;
    const failedCount = items.length - processedCount;
    const fallbackDepths = items.map((item) => item.provenance.fallbackDepth);

    return {
      requestedCount: input.videoIdsOrUrls.length,
      processedCount,
      failedCount,
      items,
      summary: {
        successRatePct: round((processedCount / Math.max(items.length, 1)) * 100, 1),
        avgFallbackDepth: round(average(fallbackDepths) ?? 0, 2),
      },
    };
  }

  async expandPlaylist(input: ExpandPlaylistInput, options: ServiceOptions = {}): Promise<ExpandPlaylistOutput> {
    const playlistId = this.requirePlaylistId(input.playlistUrlOrId);
    const maxVideos = clamp(input.maxVideos ?? 50, 1, 200);
    const includeVideoMeta = input.includeVideoMeta ?? false;

    const resolved = await this.executeFallback(
      {
        youtube_api: async () => {
          const [meta, videos] = await Promise.all([
            this.api.getPlaylistMeta(playlistId),
            this.api.getPlaylistVideos(playlistId, Math.min(maxVideos, 50)),
          ]);
          return {
            playlistId: meta.playlistId,
            title: meta.title,
            channelTitle: meta.channelTitle,
            videoCountReported: meta.videoCountReported,
            videos,
          };
        },
        yt_dlp: () => this.ytdlp.playlist(playlistId, maxVideos),
      },
      this.samplePlaylist(playlistId),
      options,
      { partialTiers: ["yt_dlp"] },
    );

    return {
      playlist: {
        playlistId,
        title: resolved.data.title,
        channelTitle: resolved.data.channelTitle,
        videoCountReported: resolved.data.videoCountReported,
      },
      videos: resolved.data.videos.slice(0, maxVideos).map((video) => ({
        videoId: video.videoId,
        title: includeVideoMeta ? video.title : video.title,
        publishedAt: includeVideoMeta ? video.publishedAt : video.publishedAt,
        channelTitle: includeVideoMeta ? video.channelTitle : video.channelTitle,
      })),
      truncated: (resolved.data.videoCountReported ?? resolved.data.videos.length) > maxVideos,
      provenance: resolved.provenance,
    };
  }

  async analyzePlaylist(input: AnalyzePlaylistInput, options: ServiceOptions = {}): Promise<AnalyzePlaylistOutput> {
    const maxVideos = clamp(input.maxVideos ?? 25, 1, 100);
    const expanded = await this.expandPlaylist(
      {
        playlistUrlOrId: input.playlistUrlOrId,
        maxVideos,
        includeVideoMeta: true,
      },
      options,
    );

    const analysis = await this.analyzeVideoSet(
      {
        videoIdsOrUrls: expanded.videos.map((video) => video.videoId),
        analyses: input.analyses,
        commentsSampleSize: input.commentsSampleSize,
        transcriptMode: input.transcriptMode,
      },
      options,
    );

    const sentimentScores = analysis.items
      .map((item) => item.analyses.sentiment?.sentiment.sentimentScore)
      .filter((value): value is number => value !== undefined);
    const hookScores = analysis.items
      .map((item) => item.analyses.hookPatterns?.hookScore)
      .filter((value): value is number => value !== undefined);
    const allThemes = analysis.items.flatMap((item) => item.analyses.sentiment?.themes?.map((theme) => theme.theme) ?? []);
    const viewValues = analysis.items
      .map((item) => item.analyses.videoInfo?.stats.views)
      .filter((value): value is number => value !== undefined);

    return {
      playlist: expanded.playlist,
      run: {
        maxVideos,
        processed: analysis.processedCount,
        failed: analysis.failedCount,
      },
      items: analysis.items,
      aggregate: {
        medianViews: median(viewValues),
        avgSentimentScore: average(sentimentScores),
        dominantThemes: topStrings(allThemes, 5),
        hookBenchmark: {
          medianHookScore: median(hookScores),
          topQuartileHookScore: percentile(hookScores, 0.75),
        },
      },
      provenance: this.mergeProvenances([expanded.provenance, ...analysis.items.map((item) => item.provenance)]),
    };
  }

  async importPlaylist(input: PlaylistKnowledgeBaseInput, options: ServiceOptions = {}): Promise<ImportPlaylistOutput> {
    const embeddingSelection = resolveEmbeddingSelection(input);
    const maxVideos = clamp(input.maxVideos ?? 50, 1, 200);
    const playlist = await this.expandPlaylist(
      {
        playlistUrlOrId: input.playlistUrlOrId,
        maxVideos,
        includeVideoMeta: true,
      },
      options,
    );
    const collectionId = input.collectionId ?? `playlist-${playlist.playlist.playlistId}`;
    this.knowledgeBase.ensureCollection({
      collectionId,
      label: input.label,
      sourceType: "playlist",
      sourceRef: playlist.playlist.playlistId,
      sourceTitle: playlist.playlist.title,
      sourceChannelTitle: playlist.playlist.channelTitle,
    });

    const prepared = await this.prepareKnowledgeBaseItems(
      playlist.videos.map((video) => video.videoId),
      {
        language: input.language,
        chunkStrategy: input.chunkStrategy,
        chunkSizeSec: input.chunkSizeSec,
        chunkOverlapSec: input.chunkOverlapSec,
        reindexExisting: input.reindexExisting,
      },
      collectionId,
      options,
    );

    const stored = this.knowledgeBase.importPlaylist(
      {
        collectionId,
        label: input.label,
        sourceType: "playlist",
        sourceRef: playlist.playlist.playlistId,
        sourceTitle: playlist.playlist.title,
        sourceChannelTitle: playlist.playlist.channelTitle,
      },
      playlist.playlist,
      prepared.items,
    );

    if (stored.import.imported > 0 && embeddingSelection.kind === "gemini") {
      await this.knowledgeBase.reindexCollectionEmbeddings(collectionId, embeddingSelection);
    }

    const activeCollectionId = input.activateCollection === false
      ? this.knowledgeBase.getActiveCollectionId() ?? undefined
      : this.knowledgeBase.setActiveCollection(collectionId).activeCollectionId;

    return {
      ...stored,
      import: {
        ...stored.import,
        totalVideos: prepared.totalRequested,
        skipped: stored.import.skipped + prepared.skipped,
        failed: stored.import.failed + prepared.failures.length,
      },
      failures: [...(prepared.failures ?? []), ...(stored.failures ?? [])],
      activeCollectionId,
    };
  }

  async importVideos(input: VideoKnowledgeBaseInput, options: ServiceOptions = {}): Promise<ImportVideosOutput> {
    if (!Array.isArray(input.videoIdsOrUrls) || input.videoIdsOrUrls.length === 0) {
      throw this.invalidInput("videoIdsOrUrls must contain at least one video");
    }

    const embeddingSelection = resolveEmbeddingSelection(input);
    const collectionId = input.collectionId ?? this.defaultVideoCollectionId(input);
    const prepared = await this.prepareKnowledgeBaseItems(
      input.videoIdsOrUrls.slice(0, 50),
      {
        language: input.language,
        chunkStrategy: input.chunkStrategy,
        chunkSizeSec: input.chunkSizeSec,
        chunkOverlapSec: input.chunkOverlapSec,
        reindexExisting: input.reindexExisting,
      },
      collectionId,
      options,
    );

    const stored = this.knowledgeBase.importVideos(
      {
        collectionId,
        label: input.label,
        sourceType: "videos",
      },
      prepared.items,
    );

    if (stored.import.imported > 0 && embeddingSelection.kind === "gemini") {
      await this.knowledgeBase.reindexCollectionEmbeddings(collectionId, embeddingSelection);
    }

    const activeCollectionId = input.activateCollection === false
      ? this.knowledgeBase.getActiveCollectionId() ?? undefined
      : this.knowledgeBase.setActiveCollection(collectionId).activeCollectionId;

    return {
      ...stored,
      import: {
        ...stored.import,
        totalVideos: prepared.totalRequested,
        skipped: stored.import.skipped + prepared.skipped,
        failed: stored.import.failed + prepared.failures.length,
      },
      failures: [...(prepared.failures ?? []), ...(stored.failures ?? [])],
      activeCollectionId,
    };
  }

  async searchTranscripts(input: SearchTranscriptsInput): Promise<SearchTranscriptsOutput> {
    const query = input.query?.trim();
    if (!query) {
      throw this.invalidInput("Query cannot be empty");
    }

    return this.knowledgeBase.search({
      ...input,
      query,
    });
  }

  async listCollections(input: ListCollectionsInput = {}): Promise<ListCollectionsOutput> {
    return this.knowledgeBase.listCollections(input.includeVideoList ?? false);
  }

  async setActiveCollection(input: SetActiveCollectionInput): Promise<SetActiveCollectionOutput> {
    if (!input.collectionId?.trim()) {
      throw this.invalidInput("collectionId cannot be empty");
    }
    return this.knowledgeBase.setActiveCollection(input.collectionId.trim());
  }

  async clearActiveCollection(): Promise<ClearActiveCollectionOutput> {
    return this.knowledgeBase.clearActiveCollection();
  }

  async checkImportReadiness(
    input: CheckImportReadinessInput,
    options: ServiceOptions = {},
  ): Promise<CheckImportReadinessOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);
    if (this.isDryRun(options)) {
      return this.sampleImportReadiness(videoId);
    }

    const checks: DiagnosticCheck[] = [];
    const suggestions: string[] = [];
    let title: string | undefined;
    let transcriptAvailable = false;
    let transcriptLanguages: string[] | undefined;
    let transcriptRecord: TranscriptRecord | undefined;
    let metadataProvenance: Provenance | undefined;

    if (this.api.isConfigured()) {
      try {
        const apiVideo = await this.api.getVideoInfo(videoId);
        title = title ?? apiVideo.title;
        transcriptAvailable ||= Boolean(apiVideo.transcriptAvailable);
        transcriptLanguages = apiVideo.transcriptLanguages;
        checks.push({
          name: "youtube_api_metadata",
          status: "ok",
          detail: `Metadata loaded via YouTube API. Caption flag=${apiVideo.transcriptAvailable ? "true" : "false"}.`,
        });
        metadataProvenance = this.makeProvenance("youtube_api", false);
      } catch (error) {
        checks.push({
          name: "youtube_api_metadata",
          status: "warn",
          detail: toMessage(error),
        });
        suggestions.push("If you want higher-fidelity metadata, verify YOUTUBE_API_KEY is valid and has YouTube Data API v3 enabled.");
      }
    } else {
      checks.push({
        name: "youtube_api_metadata",
        status: "skipped",
        detail: "YOUTUBE_API_KEY not configured. This is optional for transcript import.",
      });
    }

    try {
      const probe = await this.ytdlp.probe();
      checks.push({
        name: "yt_dlp_binary",
        status: "ok",
        detail: `${probe.binary} available (${probe.version}).`,
      });
    } catch (error) {
      const detail = toMessage(error);
      checks.push({
        name: "yt_dlp_binary",
        status: "error",
        detail,
      });
      suggestions.push("Install yt-dlp and make sure GUI-launched apps can see it via PATH.");
      return {
        videoId,
        title,
        importReadiness: {
          canImport: false,
          status: "blocked",
          summary: "Import is blocked because yt-dlp is unavailable.",
          suggestedCollectionId: TranscriptKnowledgeBase.videosCollectionId({ videoIdsOrUrls: [videoId] }),
        },
        transcript: {
          available: false,
        },
        checks,
        suggestions,
        provenance: metadataProvenance ?? this.makeProvenance("none", true, checks.map((check) => `${check.name}: ${check.detail}`)),
      };
    }

    try {
      const ytDlpVideo = await this.ytdlp.videoInfo(videoId);
      title = title ?? ytDlpVideo.title;
      transcriptAvailable ||= Boolean(ytDlpVideo.transcriptAvailable);
      transcriptLanguages = transcriptLanguages ?? ytDlpVideo.transcriptLanguages;
      checks.push({
        name: "yt_dlp_metadata",
        status: "ok",
        detail: `Metadata loaded via yt-dlp. Transcript advertised=${ytDlpVideo.transcriptAvailable ? "true" : "false"}.`,
      });
      metadataProvenance = metadataProvenance ?? this.makeProvenance("yt_dlp", false);
    } catch (error) {
      checks.push({
        name: "yt_dlp_metadata",
        status: "warn",
        detail: toMessage(error),
      });
    }

    try {
      transcriptRecord = await this.ytdlp.transcript(videoId, input.language);
      transcriptAvailable = true;
      const sparse = isSparseTranscript(transcriptRecord);
      const estimatedSearchableChunks = estimateTranscriptChunks(transcriptRecord);
      checks.push({
        name: "yt_dlp_transcript",
        status: sparse ? "warn" : "ok",
        detail: sparse
          ? `Transcript fetched but is sparse (${transcriptRecord.transcriptText.length} chars, ${transcriptRecord.segments.length} segments). Import should still work via whole-transcript fallback.`
          : `Transcript fetched successfully (${transcriptRecord.transcriptText.length} chars, ${transcriptRecord.segments.length} segments).`,
      });
      if (sparse) {
        suggestions.push("This transcript is sparse. V2 now imports it as a single searchable chunk instead of failing, but search quality may be shallow.");
      }
    } catch (error) {
      const detail = toMessage(error);
      checks.push({
        name: "yt_dlp_transcript",
        status: "error",
        detail,
      });
      suggestions.push("Try a video with public captions or confirm the video is not region/age restricted.");
      if (detail.toLowerCase().includes("subtitle") || detail.toLowerCase().includes("caption")) {
        suggestions.push("If this specific video has no public subtitle track, import will stay blocked until captions are available.");
      }
    }

    if (!title) {
      try {
        const pageVideo = await this.pageExtract.getVideoInfo(videoId);
        title = pageVideo.title;
        checks.push({
          name: "page_extract_metadata",
          status: "ok",
          detail: "Public watch-page metadata extracted successfully.",
        });
        metadataProvenance = metadataProvenance ?? this.makeProvenance("page_extract", true);
      } catch (error) {
        checks.push({
          name: "page_extract_metadata",
          status: "warn",
          detail: toMessage(error),
        });
      }
    }

    const sparseTranscript = transcriptRecord ? isSparseTranscript(transcriptRecord) : undefined;
    const canImport = Boolean(transcriptRecord);
    const status = !canImport
      ? (transcriptAvailable ? "uncertain" : "blocked")
      : sparseTranscript
        ? "ready_sparse_transcript"
        : "ready";
    const summary = !canImport
      ? (transcriptAvailable
          ? "Metadata suggests captions may exist, but the transcript could not be fetched right now."
          : "Transcript import is currently blocked because no usable public caption track could be fetched.")
      : sparseTranscript
        ? "Transcript is importable, but sparse. V2 will preserve it as a single searchable chunk."
        : "Transcript is importable and should chunk normally for semantic search.";

    if (!canImport && !this.api.isConfigured()) {
      suggestions.push("Adding YOUTUBE_API_KEY helps metadata diagnostics, even though transcript import still depends on public captions via yt-dlp.");
    }

    return {
      videoId,
      title,
      importReadiness: {
        canImport,
        status,
        summary,
        suggestedCollectionId: TranscriptKnowledgeBase.videosCollectionId({ videoIdsOrUrls: [videoId] }),
      },
      transcript: {
        available: transcriptAvailable,
        sourceType: transcriptRecord?.sourceType,
        languageUsed: transcriptRecord?.languageUsed,
        segmentCount: transcriptRecord?.segments.length,
        transcriptCharacters: transcriptRecord?.transcriptText.length,
        sparseTranscript,
        estimatedSearchableChunks: transcriptRecord ? estimateTranscriptChunks(transcriptRecord) : undefined,
      },
      checks,
      suggestions: dedupeStrings(suggestions),
      provenance: metadataProvenance ?? this.makeProvenance("none", true, checks.map((check) => `${check.name}: ${check.detail}`)),
    };
  }

  async buildVideoDossier(
    input: BuildVideoDossierInput,
    options: ServiceOptions = {},
  ): Promise<BuildVideoDossierOutput> {
    const includeComments = input.includeComments ?? true;
    const includeSentiment = input.includeSentiment ?? true;
    const includeTranscriptSummary = input.includeTranscriptSummary ?? true;
    const commentSampleSize = clamp(input.commentSampleSize ?? 8, 1, 50);

    const [video, readiness] = await Promise.all([
      this.inspectVideo({
        videoIdOrUrl: input.videoIdOrUrl,
        includeTranscriptMeta: true,
        includeEngagementRatios: true,
      }, options),
      this.checkImportReadiness({
        videoIdOrUrl: input.videoIdOrUrl,
      }, options),
    ]);

    const parallelOps = await Promise.allSettled([
      includeTranscriptSummary && readiness.importReadiness.canImport
        ? this.readTranscript({ videoIdOrUrl: input.videoIdOrUrl, mode: "summary" }, options)
        : Promise.resolve(undefined),
      includeComments
        ? this.readComments({ videoIdOrUrl: input.videoIdOrUrl, maxTopLevel: commentSampleSize }, options)
        : Promise.resolve(undefined),
      includeSentiment
        ? this.measureAudienceSentiment({ videoIdOrUrl: input.videoIdOrUrl, sampleSize: commentSampleSize }, options)
        : Promise.resolve(undefined),
    ]);

    const transcriptSummary = parallelOps[0].status === "fulfilled" && parallelOps[0].value
      ? (parallelOps[0].value as ReadTranscriptOutput).transcript.text
      : undefined;
    const comments = parallelOps[1].status === "fulfilled" ? parallelOps[1].value as ReadCommentsOutput | undefined : undefined;
    const sentiment = parallelOps[2].status === "fulfilled" ? parallelOps[2].value as MeasureAudienceSentimentOutput | undefined : undefined;

    return {
      video: video.video,
      stats: video.stats,
      transcript: {
        available: readiness.transcript.available,
        importReadiness: readiness.importReadiness,
        languageUsed: readiness.transcript.languageUsed,
        sourceType: readiness.transcript.sourceType,
        summary: transcriptSummary,
        sparseTranscript: readiness.transcript.sparseTranscript,
      },
      comments: comments
        ? {
            totalFetched: comments.totalFetched,
            sample: comments.threads.map((thread) => ({
              author: thread.author,
              text: thread.text,
              likeCount: thread.likeCount,
              publishedAt: thread.publishedAt,
            })),
          }
        : undefined,
      audienceSentiment: sentiment?.sentiment,
      riskSignals: sentiment?.riskSignals,
      representativeQuotes: sentiment?.representativeQuotes,
      suggestedCollectionId: readiness.importReadiness.suggestedCollectionId,
      checks: readiness.checks,
      provenance: this.mergeProvenances([
        video.provenance,
        readiness.provenance,
        comments?.provenance,
        sentiment?.provenance,
      ].filter(Boolean) as Provenance[]),
    };
  }

  async checkSystemHealth(input: CheckSystemHealthInput = {}, options: ServiceOptions = {}): Promise<CheckSystemHealthOutput> {
    if (this.isDryRun(options)) {
      return this.sampleSystemHealth();
    }

    const runLiveChecks = input.runLiveChecks ?? true;
    const checks: DiagnosticCheck[] = [];
    const suggestions: string[] = [];
    const packageMeta = readPackageMetadata();
    const clients: ClientDetectionSummary[] = detectKnownClients();
    const youtubeApiConfigured = this.api.isConfigured();
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

    try {
      const probe = await this.ytdlp.probe();
      checks.push({
        name: "yt_dlp",
        status: "ok",
        detail: `${probe.binary} available (${probe.version}).`,
      });
    } catch (error) {
      checks.push({
        name: "yt_dlp",
        status: "error",
        detail: toMessage(error),
      });
      suggestions.push("Install yt-dlp and expose it in PATH for your MCP client runtime.");
    }

    if (youtubeApiConfigured) {
      if (runLiveChecks) {
        try {
          await this.api.getVideoInfo("jNQXAC9IVRw");
          checks.push({
            name: "youtube_api",
            status: "ok",
            detail: "YouTube API key is configured and passed a live metadata probe.",
          });
        } catch (error) {
          checks.push({
            name: "youtube_api",
            status: "warn",
            detail: toMessage(error),
          });
          suggestions.push("Verify YOUTUBE_API_KEY and confirm the YouTube Data API v3 is enabled for that project.");
        }
      } else {
        checks.push({
          name: "youtube_api",
          status: "ok",
          detail: "YOUTUBE_API_KEY configured. Live probe skipped.",
        });
      }
    } else {
      checks.push({
        name: "youtube_api",
        status: "skipped",
        detail: "YOUTUBE_API_KEY not configured. Metadata fallbacks still work, but quotas and fidelity are lower.",
      });
      suggestions.push("Add YOUTUBE_API_KEY if you want stronger metadata diagnostics and less fallback reliance.");
    }

    if (geminiConfigured) {
      if (runLiveChecks) {
        try {
          const provider = await createEmbeddingProvider(resolveEmbeddingSelection({ embeddingProvider: "gemini" }));
          await provider?.embedQuery("youtube import health check");
          checks.push({
            name: "gemini_embeddings",
            status: "ok",
            detail: "Gemini embedding provider is configured and passed a live embedding probe.",
          });
        } catch (error) {
          checks.push({
            name: "gemini_embeddings",
            status: "warn",
            detail: toMessage(error),
          });
          suggestions.push("Verify GEMINI_API_KEY/GOOGLE_API_KEY if you want cloud embeddings.");
        }
      } else {
        checks.push({
          name: "gemini_embeddings",
          status: "ok",
          detail: "Gemini embedding key configured. Live probe skipped.",
        });
      }
    } else {
      checks.push({
        name: "gemini_embeddings",
        status: "skipped",
        detail: "No Gemini key configured. Local embeddings remain available.",
      });
    }

    try {
      const probeFile = join(this.knowledgeBase.dataDir, `.health-${Date.now()}.tmp`);
      writeFileSync(probeFile, "ok\n", "utf8");
      unlinkSync(probeFile);
      checks.push({
        name: "storage",
        status: "ok",
        detail: `Knowledge-base directory is writable (${this.knowledgeBase.dataDir}).`,
      });
    } catch (error) {
      checks.push({
        name: "storage",
        status: "error",
        detail: toMessage(error),
      });
      suggestions.push("Ensure VIDLENS_DATA_DIR points to a writable directory.");
    }

    const supportedClientDetected = clients.some((client) => client.supportLevel === "supported" && client.detected);
    if (!supportedClientDetected) {
      suggestions.push("No supported MCP client was detected automatically. Claude Desktop and Claude Code are the best-supported install targets.");
    }

    const overallStatus = checks.some((check) => check.status === "error")
      ? "degraded"
      : checks.every((check) => check.status === "skipped")
        ? "setup_needed"
        : "ready";

    return {
      overallStatus,
      dataDir: this.knowledgeBase.dataDir,
      runtime: {
        nodeVersion: process.version,
        packageName: packageMeta.name,
        packageVersion: packageMeta.version,
      },
      keys: {
        youtubeApiConfigured,
        geminiConfigured,
      },
      clients,
      checks,
      suggestions: dedupeStrings(suggestions),
      provenance: this.makeProvenance("none", overallStatus !== "ready", checks.map((check) => `${check.name}: ${check.detail}`)),
    };
  }

  async removeCollection(input: RemoveCollectionInput): Promise<RemoveCollectionOutput> {
    if (!input.collectionId?.trim()) {
      throw this.invalidInput("collectionId cannot be empty");
    }
    return this.knowledgeBase.removeCollection(input.collectionId.trim());
  }

  // ── Comment Knowledge Base ──

  async importComments(input: ImportCommentsInput, options: ServiceOptions = {}): Promise<ImportCommentsOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);
    const collectionId = input.collectionId ?? CommentKnowledgeBase.videoCommentCollectionId(videoId);
    const maxTopLevel = clamp(input.maxTopLevel ?? 100, 1, 200);
    const includeReplies = input.includeReplies ?? true;
    const maxRepliesPerThread = clamp(input.maxRepliesPerThread ?? 5, 0, 20);

    // Fetch video metadata for title
    let videoTitle = "Unknown video";
    let channelTitle = "Unknown channel";
    try {
      const videoInfo = await this.inspectVideo({ videoIdOrUrl: videoId }, options);
      videoTitle = videoInfo.video.title;
      channelTitle = videoInfo.video.channelTitle;
    } catch {
      // Best-effort metadata
    }

    // Fetch comments
    const commentsOutput = await this.readComments({
      videoIdOrUrl: videoId,
      maxTopLevel,
      includeReplies,
      maxRepliesPerThread,
      order: input.order ?? "relevance",
    }, options);

    // Convert to CommentRecord[]
    const comments: CommentRecord[] = commentsOutput.threads.map((thread) => ({
      commentId: thread.commentId,
      author: thread.author,
      text: thread.text,
      likeCount: thread.likeCount,
      publishedAt: thread.publishedAt,
      replies: thread.replies?.map((reply) => ({
        commentId: reply.commentId,
        author: reply.author,
        text: reply.text,
        likeCount: reply.likeCount,
        publishedAt: reply.publishedAt,
      })),
    }));

    const result = this.commentKnowledgeBase.importComments(
      { collectionId, label: input.label },
      [{ videoId, videoTitle, channelTitle, comments }],
    );

    const activeCollectionId = input.activateCollection === false
      ? this.commentKnowledgeBase.getActiveCollectionId() ?? undefined
      : this.commentKnowledgeBase.setActiveCollection(collectionId).activeCollectionId;

    return {
      ...result,
      activeCollectionId,
    };
  }

  async searchComments(input: SearchCommentsInput): Promise<SearchCommentsOutput> {
    const query = input.query?.trim();
    if (!query) {
      throw this.invalidInput("Query cannot be empty");
    }
    return this.commentKnowledgeBase.search({ ...input, query });
  }

  async listCommentCollections(input: ListCommentCollectionsInput = {}): Promise<ListCommentCollectionsOutput> {
    return this.commentKnowledgeBase.listCollections(input.includeVideoList ?? false);
  }

  async setActiveCommentCollection(input: SetActiveCommentCollectionInput): Promise<SetActiveCommentCollectionOutput> {
    if (!input.collectionId?.trim()) {
      throw this.invalidInput("collectionId cannot be empty");
    }
    return this.commentKnowledgeBase.setActiveCollection(input.collectionId.trim());
  }

  async clearActiveCommentCollection(): Promise<ClearActiveCommentCollectionOutput> {
    return this.commentKnowledgeBase.clearActiveCollection();
  }

  async removeCommentCollection(input: RemoveCommentCollectionInput): Promise<RemoveCommentCollectionOutput> {
    if (!input.collectionId?.trim()) {
      throw this.invalidInput("collectionId cannot be empty");
    }
    return this.commentKnowledgeBase.removeCollection(input.collectionId.trim());
  }

  // ── Media / Asset tools ──

  async downloadAsset(input: DownloadAssetInput, options: ServiceOptions = {}): Promise<DownloadAssetOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);

    if (this.isDryRun(options)) {
      const kind = input.format === "best_audio" ? "audio" : input.format === "thumbnail" ? "thumbnail" : "video";
      const extension = kind === "thumbnail" ? "jpg" : kind === "audio" ? "m4a" : "mp4";
      return {
        asset: {
          assetId: `dry-${kind}-${videoId}`,
          videoId,
          kind,
          filePath: join(this.mediaStore.videoDir(videoId), kind === "thumbnail" ? `${videoId}-thumb.${extension}` : `${videoId}.${extension}`),
          fileName: kind === "thumbnail" ? `${videoId}-thumb.${extension}` : `${videoId}.${extension}`,
          fileSizeBytes: 0,
          mimeType: kind === "thumbnail" ? "image/jpeg" : kind === "audio" ? "audio/mp4" : "video/mp4",
        },
        downloadedBytes: 0,
        durationMs: 0,
        cached: false,
        provenance: this.makeProvenance("none", false, ["Dry-run media download — no files were written."]),
      };
    }

    const result = await this.mediaDownloader.download({
      videoIdOrUrl: videoId,
      format: input.format,
      maxSizeMb: input.maxSizeMb,
    });

    return {
      asset: {
        assetId: result.asset.assetId,
        videoId: result.asset.videoId,
        kind: result.asset.kind,
        filePath: result.asset.filePath,
        fileName: result.asset.fileName,
        fileSizeBytes: result.asset.fileSizeBytes,
        mimeType: result.asset.mimeType,
        durationSec: result.asset.durationSec,
        width: result.asset.width,
        height: result.asset.height,
      },
      downloadedBytes: result.downloadedBytes,
      durationMs: result.durationMs,
      cached: result.downloadedBytes === 0,
      provenance: this.makeProvenance("yt_dlp", false, ["Asset downloaded into the local media store."]),
    };
  }

  async listMediaAssets(input: ListMediaAssetsInput = {}): Promise<ListMediaAssetsOutput> {
    const kind = input.kind;
    const limit = clamp(input.limit ?? 100, 1, 500);
    let assets = input.videoIdOrUrl
      ? this.mediaStore.listAssetsForVideo(this.requireVideoId(input.videoIdOrUrl))
      : this.mediaStore.listAllAssets({ kind, limit });

    if (input.videoIdOrUrl && kind) {
      assets = assets.filter((asset) => asset.kind === kind);
    }
    if (input.videoIdOrUrl) {
      assets = assets.slice(0, limit);
    }

    const stats = this.mediaStore.getStats();
    return {
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        videoId: asset.videoId,
        kind: asset.kind,
        filePath: asset.filePath,
        fileName: asset.fileName,
        fileSizeBytes: asset.fileSizeBytes,
        mimeType: asset.mimeType,
        timestampSec: asset.timestampSec,
        width: asset.width,
        height: asset.height,
        durationSec: asset.durationSec,
        createdAt: asset.createdAt,
      })),
      stats: {
        totalAssets: stats.totalAssets,
        totalSizeBytes: stats.totalSizeBytes,
        videoCount: stats.videoCount,
        byKind: stats.byKind,
      },
      provenance: this.makeProvenance("none", false, ["Read from the local media asset manifest."]),
    };
  }

  async removeMediaAsset(input: RemoveMediaAssetInput): Promise<RemoveMediaAssetOutput> {
    const deleteFiles = input.deleteFiles ?? true;
    if (!input.assetId && !input.videoIdOrUrl) {
      throw this.invalidInput("Provide either assetId or videoIdOrUrl so the media store knows what to remove.");
    }

    let removed = 0;
    let freedBytes = 0;

    if (input.assetId) {
      const asset = this.mediaStore.getAsset(input.assetId);
      if (asset) {
        freedBytes = asset.fileSizeBytes;
        this.mediaStore.removeAsset(input.assetId, deleteFiles);
        removed = 1;
      }
    } else if (input.videoIdOrUrl) {
      const videoId = this.requireVideoId(input.videoIdOrUrl);
      const assets = this.mediaStore.listAssetsForVideo(videoId);
      freedBytes = assets.reduce((sum, asset) => sum + asset.fileSizeBytes, 0);
      removed = this.mediaStore.removeVideoAssets(videoId, deleteFiles);
    }

    return {
      removed,
      freedBytes,
      provenance: this.makeProvenance("none", false, [
        deleteFiles
          ? "Manifest entries and files were removed from local storage."
          : "Manifest entries were removed; files were left on disk.",
      ]),
    };
  }

  async extractKeyframes(input: ExtractKeyframesInput, options: ServiceOptions = {}): Promise<ExtractKeyframesOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);

    if (this.isDryRun(options)) {
      return {
        videoId,
        framesExtracted: 0,
        assets: [],
        durationMs: 0,
        provenance: this.makeProvenance("none", false, ["Dry-run keyframe extraction — ffmpeg was not invoked."]),
      };
    }

    const result = await this.thumbnailExtractor.extractKeyframes({
      videoId,
      intervalSec: input.intervalSec,
      maxFrames: input.maxFrames,
      imageFormat: input.imageFormat,
      width: input.width,
    });

    return {
      videoId: result.videoId,
      framesExtracted: result.framesExtracted,
      assets: result.assets.map((asset) => ({
        assetId: asset.assetId,
        filePath: asset.filePath,
        timestampSec: asset.timestampSec ?? 0,
        width: asset.width,
        height: asset.height,
        fileSizeBytes: asset.fileSizeBytes,
      })),
      durationMs: result.durationMs,
      provenance: this.makeProvenance("none", false, ["Keyframes were extracted locally via ffmpeg."]),
    };
  }

  async mediaStoreHealth(): Promise<MediaStoreHealthOutput> {
    const stats = this.mediaStore.getStats();
    let ffmpegAvailable = false;
    let ffmpegVersion: string | undefined;
    let ytdlpAvailable = false;
    let ytdlpVersion: string | undefined;

    try {
      const probe = await this.thumbnailExtractor.probe();
      ffmpegAvailable = true;
      ffmpegVersion = probe.ffmpeg;
    } catch {
      ffmpegAvailable = false;
    }

    try {
      const probe = await this.mediaDownloader.probe();
      ytdlpAvailable = true;
      ytdlpVersion = probe.version;
    } catch {
      ytdlpAvailable = false;
    }

    return {
      dataDir: this.mediaStore.dataDir,
      assetsDir: this.mediaStore.assetsDir,
      stats: {
        totalAssets: stats.totalAssets,
        totalSizeBytes: stats.totalSizeBytes,
        videoCount: stats.videoCount,
        byKind: stats.byKind,
      },
      ffmpegAvailable,
      ffmpegVersion,
      ytdlpAvailable,
      ytdlpVersion,
      provenance: this.makeProvenance("none", !(ffmpegAvailable && ytdlpAvailable), [
        ffmpegAvailable ? `ffmpeg available: ${ffmpegVersion}` : "ffmpeg not detected",
        ytdlpAvailable ? `yt-dlp available: ${ytdlpVersion}` : "yt-dlp not detected",
      ]),
    };
  }

  async indexVisualContent(input: IndexVisualContentInput, options: ServiceOptions = {}): Promise<IndexVisualContentOutput> {
    const videoId = this.requireVideoId(input.videoIdOrUrl);

    if (this.isDryRun(options)) {
      return this.sampleVisualIndex(videoId);
    }

    const sourceVideo = await this.inspectVideo({ videoIdOrUrl: videoId }, options).catch(() => undefined);
    const indexed = await this.visualSearch.indexVideo({
      videoId,
      sourceVideoTitle: sourceVideo?.video.title,
      sourceVideoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      intervalSec: input.intervalSec,
      maxFrames: input.maxFrames,
      imageFormat: input.imageFormat,
      width: input.width,
      autoDownload: input.autoDownload,
      downloadFormat: input.downloadFormat,
      forceReindex: input.forceReindex,
      includeGeminiDescriptions: input.includeGeminiDescriptions,
      includeGeminiEmbeddings: input.includeGeminiEmbeddings,
    });

    return {
      videoId,
      sourceVideo: {
        videoId,
        url: indexed.sourceVideoUrl,
        title: indexed.sourceVideoTitle,
        localVideoPath: indexed.videoAssetPath,
      },
      indexing: {
        framesExtracted: indexed.framesExtracted,
        framesAnalyzed: indexed.framesAnalyzed,
        framesIndexed: indexed.framesIndexed,
        intervalSec: indexed.intervalSec,
        maxFrames: indexed.maxFrames,
        autoDownloaded: indexed.autoDownloaded,
        descriptionProvider: indexed.descriptionProvider,
        descriptionModel: indexed.descriptionModel,
        embeddingProvider: indexed.embeddingProvider,
        embeddingModel: indexed.embeddingModel,
        embeddingDimensions: indexed.embeddingDimensions,
      },
      evidence: indexed.evidence.map((frame) => ({
        frameAssetId: frame.frameAssetId,
        framePath: frame.framePath,
        timestampSec: frame.timestampSec,
        timestampLabel: formatTimestamp(frame.timestampSec),
        ocrText: frame.ocrText,
        visualDescription: frame.visualDescription,
      })),
      limitations: indexed.limitations,
      provenance: this.makeProvenance("none", indexed.descriptionProvider !== "gemini", [
        "Frames extracted locally with ffmpeg.",
        "OCR + image feature prints computed with Apple Vision.",
        indexed.descriptionProvider === "gemini"
          ? `Gemini descriptions enabled (${indexed.descriptionModel}).`
          : "Gemini descriptions disabled; OCR-only frame indexing.",
      ]),
    };
  }

  async searchVisualContent(input: SearchVisualContentInput, options: ServiceOptions = {}): Promise<SearchVisualContentOutput> {
    const query = input.query?.trim();
    if (!query) {
      throw this.invalidInput("query cannot be empty");
    }

    const videoId = input.videoIdOrUrl ? this.requireVideoId(input.videoIdOrUrl) : undefined;

    if (this.isDryRun(options)) {
      return this.sampleVisualSearch(query, videoId);
    }

    const result = await this.visualSearch.searchText({
      query,
      videoId,
      maxResults: input.maxResults,
      minScore: input.minScore,
      autoIndexIfNeeded: input.autoIndexIfNeeded,
      indexIfNeeded: {
        intervalSec: input.intervalSec,
        maxFrames: input.maxFrames,
        imageFormat: input.imageFormat,
        width: input.width,
        autoDownload: input.autoDownload,
        downloadFormat: input.downloadFormat,
        includeGeminiDescriptions: input.includeGeminiDescriptions,
        includeGeminiEmbeddings: input.includeGeminiEmbeddings,
      },
    });

    return {
      query,
      results: result.results,
      searchMeta: {
        searchedFrames: result.searchedFrames,
        searchedVideos: result.searchedVideos,
        descriptionProvider: result.descriptionProvider,
        embeddingProvider: result.embeddingProvider,
        embeddingModel: result.embeddingModel,
        queryMode: result.queryMode,
      },
      coveredTimeRange: result.coveredTimeRange,
      needsExpansion: result.needsExpansion,
      limitations: result.limitations,
      provenance: this.makeProvenance("none", result.descriptionProvider === "none" && result.embeddingProvider === "none", [
        "Search ran over the visual frame index, not transcript embeddings.",
        "Each match includes a local frame path and timestamp for direct visual evidence.",
        result.embeddingProvider !== "none"
          ? `Gemini semantic retrieval active (${result.embeddingModel ?? "gemini-embedding-2-preview"}).`
          : result.descriptionProvider !== "none"
            ? "Gemini frame descriptions enhance lexical search but no embedding retrieval."
            : "Current index has OCR-backed lexical matches only.",
      ]),
    };
  }

  async findSimilarFrames(input: FindSimilarFramesInput, options: ServiceOptions = {}): Promise<FindSimilarFramesOutput> {
    if (!input.assetId && !input.framePath) {
      throw this.invalidInput("Provide either assetId or framePath.");
    }

    if (this.isDryRun(options)) {
      return this.sampleSimilarFrames(input.assetId, input.framePath);
    }

    const videoId = input.videoIdOrUrl ? this.requireVideoId(input.videoIdOrUrl) : undefined;
    const result = await this.visualSearch.findSimilarFrames({
      assetId: input.assetId,
      framePath: input.framePath,
      videoId,
      maxResults: input.maxResults,
      minSimilarity: input.minSimilarity,
    });

    return {
      reference: result.reference,
      results: result.results,
      searchMeta: {
        searchedFrames: result.searchedFrames,
        similarityEngine: "apple_vision_feature_print",
      },
      limitations: result.limitations,
      provenance: this.makeProvenance("none", false, [
        "Similarity was computed with Apple Vision feature prints.",
        "Results are image-to-image matches and include file paths for inspection.",
      ]),
    };
  }

  async scoreHookPatterns(input: ScoreHookPatternsInput, options: ServiceOptions = {}): Promise<ScoreHookPatternsOutput> {
    if (!Array.isArray(input.videoIdsOrUrls) || input.videoIdsOrUrls.length === 0) {
      throw this.invalidInput("videoIdsOrUrls must contain at least one video");
    }
    const hookWindowSec = clamp(input.hookWindowSec ?? 30, 10, 120);
    const videos: ScoreHookPatternsOutput["videos"] = [];
    const provenances: Provenance[] = [];
    const failureNotes: string[] = [];

    for (const raw of input.videoIdsOrUrls.slice(0, 20)) {
      const videoId = parseVideoId(raw);
      if (!videoId) {
        failureNotes.push(`Skipped invalid video reference: ${raw}`);
        continue;
      }
      try {
        const transcript = await this.readTranscript(
          {
            videoIdOrUrl: videoId,
            mode: "full",
            limit: 12000,
          },
          options,
        );
        const transcriptRecord: TranscriptRecord = {
          videoId,
          languageUsed: transcript.languageUsed,
          sourceType: transcript.quality.sourceType,
          confidence: transcript.quality.confidence,
          transcriptText: transcript.transcript.text ?? transcript.transcript.segments?.map((segment) => segment.text).join(" ") ?? "",
          segments: transcript.transcript.segments?.map((segment) => ({
            tStartSec: segment.tStartSec,
            tEndSec: segment.tEndSec,
            text: segment.text,
          })) ?? [],
          chapters: transcript.chapters,
        };
        const hook = scoreHookPattern(videoId, transcriptRecord, hookWindowSec);
        videos.push({
          videoId,
          hookScore: hook.hookScore,
          hookType: hook.hookType,
          first30SecSummary: hook.first30SecSummary,
          weakSignals: hook.weakSignals,
          improvements: hook.improvements,
        });
        provenances.push(transcript.provenance);
      } catch (error) {
        failureNotes.push(`${videoId}: ${toMessage(error)}`);
      }
    }

    if (videos.length === 0) {
      throw new ToolExecutionError({
        code: "UPSTREAM_UNAVAILABLE",
        message: "Could not score hooks for any of the requested videos.",
        retryable: true,
        attemptedTiers: ["yt_dlp"],
        suggestion: "Ensure subtitles are available for the selected videos or try videos with public captions.",
      });
    }

    const scores = videos.map((video) => video.hookScore);
    const provenance = this.mergeProvenances(provenances);
    if (failureNotes.length > 0) {
      provenance.partial = true;
      provenance.sourceNotes = [...(provenance.sourceNotes ?? []), ...failureNotes];
    }

    return {
      videos,
      benchmark: {
        medianHookScore: median(scores) ?? 0,
        topQuartileHookScore: percentile(scores, 0.75) ?? 0,
      },
      provenance,
    };
  }

  async researchTagsAndTitles(
    input: ResearchTagsAndTitlesInput,
    options: ServiceOptions = {},
  ): Promise<ResearchTagsAndTitlesOutput> {
    const seedTopic = input.seedTopic?.trim();
    if (!seedTopic) {
      throw this.invalidInput("seedTopic cannot be empty");
    }

    const maxExamples = clamp(input.maxExamples ?? 20, 3, 20);
    const search = await this.findVideos(
      {
        query: seedTopic,
        maxResults: maxExamples,
        regionCode: input.regionCode,
      },
      options,
    );

    const rawExamples = await Promise.all(
      search.results.slice(0, Math.min(search.results.length, 10)).map(async (result) => {
        try {
          return await this.inspectVideo({ videoIdOrUrl: result.videoId }, options);
        } catch {
          return undefined;
        }
      }),
    );

    const videos: VideoRecord[] = rawExamples
      .filter((item): item is InspectVideoOutput => Boolean(item))
      .map((item) => ({
        videoId: item.video.videoId,
        title: item.video.title,
        channelId: item.video.channelId,
        channelTitle: item.video.channelTitle,
        publishedAt: item.video.publishedAt,
        durationSec: item.video.durationSec,
        views: item.stats.views,
        likes: item.stats.likes,
        comments: item.stats.comments,
        tags: item.video.tags,
        language: item.video.language,
        category: item.video.category,
        url: "",
      }));

    const recurringKeywords = extractRecurringKeywords(videos.length > 0 ? videos : search.results.map((result) => ({
      videoId: result.videoId,
      title: result.title,
      channelTitle: result.channelTitle,
      url: "",
      tags: [],
    } as VideoRecord)));
    const titleStructures = topStrings((videos.length > 0 ? videos : search.results.map((result) => ({ title: result.title } as Pick<VideoRecord, "title">))).map((video) => titleStructure(video.title)), 6);

    const sortedByViews = [...videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    const topHalf = sortedByViews.slice(0, Math.max(1, Math.ceil(sortedByViews.length / 2)));
    const bottomThird = sortedByViews.slice(Math.floor(sortedByViews.length * 0.66));

    return {
      seedTopic,
      winningPatterns: {
        titleStructures,
        recurringKeywords,
        highSignalTags: extractRecurringKeywords(topHalf, 10),
        lowSignalTags: extractRecurringKeywords(bottomThird, 10).filter((tag) => !extractRecurringKeywords(topHalf, 10).includes(tag)),
      },
      examples: (videos.length > 0 ? videos : search.results.map((result) => ({
        videoId: result.videoId,
        title: result.title,
        tags: undefined,
        views: result.views,
        engagementRate: result.engagementRate,
      }))).slice(0, maxExamples).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        tags: video.tags,
        views: video.views,
        engagementRate: computeEngagementRate(video),
      })),
      provenance: search.provenance,
    };
  }

  async compareShortsVsLong(
    input: CompareShortsVsLongInput,
    options: ServiceOptions = {},
  ): Promise<CompareShortsVsLongOutput> {
    const catalog = await this.listChannelCatalog(
      {
        channelIdOrHandleOrUrl: input.channelIdOrHandleOrUrl,
        maxResults: 50,
        publishedWithinDays: input.lookbackDays ?? 180,
      },
      options,
    );

    const shorts = catalog.items.filter((item) => item.format === "short");
    const longForm = catalog.items.filter((item) => item.format === "long");

    const shortEngagements = shorts.map((item) => rate(item.likes, item.comments, item.views)).filter(isNumber);
    const longEngagements = longForm.map((item) => rate(item.likes, item.comments, item.views)).filter(isNumber);
    const shortCommentRates = shorts.map((item) => rate(item.comments, undefined, item.views)).filter(isNumber);
    const longCommentRates = longForm.map((item) => rate(item.comments, undefined, item.views)).filter(isNumber);

    const shortsBetter = (median(shortEngagements) ?? 0) >= (median(longEngagements) ?? 0);
    return {
      channelId: catalog.channelId,
      shorts: {
        count: shorts.length,
        medianViews: median(shorts.map((item) => item.views ?? 0)),
        medianEngagementRate: median(shortEngagements),
        medianCommentRate: median(shortCommentRates),
      },
      longForm: {
        count: longForm.length,
        medianViews: median(longForm.map((item) => item.views ?? 0)),
        medianEngagementRate: median(longEngagements),
        medianCommentRate: median(longCommentRates),
      },
      recommendation: {
        suggestedMixShortPct: shortsBetter ? 60 : 40,
        suggestedMixLongPct: shortsBetter ? 40 : 60,
        rationale: [
          shortsBetter
            ? "Shorts show stronger or comparable engagement efficiency in the sampled catalog."
            : "Long-form videos show stronger engagement efficiency in the sampled catalog.",
          shorts.length === 0 || longForm.length === 0
            ? "The catalog is format-skewed, so treat this recommendation as directional only."
            : "Recommendation uses recent catalog mix, not absolute channel strategy certainty.",
        ],
      },
      provenance: catalog.provenance,
    };
  }

  async recommendUploadWindows(
    input: RecommendUploadWindowsInput,
    options: ServiceOptions = {},
  ): Promise<RecommendUploadWindowsOutput> {
    const catalog = await this.listChannelCatalog(
      {
        channelIdOrHandleOrUrl: input.channelIdOrHandleOrUrl,
        maxResults: 60,
        publishedWithinDays: input.lookbackDays ?? 120,
      },
      options,
    );

    const slots = new Map<string, { weekday: RecommendUploadWindowsOutput["recommendedSlots"][number]["weekday"]; hourLocal: number; count: number; views: number[] }>();
    for (const item of catalog.items) {
      if (!item.publishedAt) {
        continue;
      }
      const date = new Date(item.publishedAt);
      if (Number.isNaN(date.getTime())) {
        continue;
      }
      const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: input.timezone }).format(date) as RecommendUploadWindowsOutput["recommendedSlots"][number]["weekday"];
      const hourLocal = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: input.timezone }).format(date));
      const key = `${weekday}-${hourLocal}`;
      const current = slots.get(key) ?? { weekday, hourLocal, count: 0, views: [] };
      current.count += 1;
      if (item.views) current.views.push(item.views);
      slots.set(key, current);
    }

    const ranked = Array.from(slots.values())
      .sort((a, b) => {
        const scoreA = a.count * 1000 + (median(a.views) ?? 0);
        const scoreB = b.count * 1000 + (median(b.views) ?? 0);
        return scoreB - scoreA;
      })
      .slice(0, 3);

    const maxCount = Math.max(...ranked.map((slot) => slot.count), 1);
    const recommendedSlots = ranked.map((slot) => ({
      weekday: slot.weekday,
      hourLocal: slot.hourLocal,
      confidence: round(slot.count / maxCount, 2),
      rationale: `${slot.count} recent uploads landed in this slot with median views ${median(slot.views) ?? 0}.`,
    }));

    return {
      channelId: catalog.channelId,
      recommendedSlots,
      observedPatterns: {
        bestDay: ranked[0]?.weekday,
        bestHour: ranked[0]?.hourLocal,
        consistencyScore: round(((ranked[0]?.count ?? 0) / Math.max(catalog.items.length, 1)) * 100, 1),
      },
      provenance: catalog.provenance,
    };
  }

  // ─── Trends & Discovery ────────────────────────────────────────────

  async discoverNicheTrends(
    input: DiscoverNicheTrendsInput,
    options: ServiceOptions = {},
  ): Promise<DiscoverNicheTrendsOutput> {
    const niche = input.niche?.trim();
    if (!niche) {
      throw this.invalidInput("niche cannot be empty");
    }

    const maxResults = clamp(input.maxResults ?? 20, 5, 25);
    const lookbackDays = clamp(input.lookbackDays ?? 90, 7, 365);

    const limitations: string[] = [];

    // Phase 1 & 2: search for recent and top-performing videos in parallel
    const [recentSearch, topSearch] = await Promise.all([
      this.findVideos(
        {
          query: niche,
          maxResults,
          order: "date",
          regionCode: input.regionCode,
          publishedAfter: new Date(Date.now() - lookbackDays * 86_400_000).toISOString(),
        },
        options,
      ),
      this.findVideos(
        {
          query: niche,
          maxResults: Math.min(maxResults, 15),
          order: "viewCount",
          regionCode: input.regionCode,
        },
        options,
      ),
    ]);

    // Merge and deduplicate
    const seen = new Set<string>();
    const allResults = [...recentSearch.results, ...topSearch.results];
    const deduped = allResults.filter((item) => {
      if (seen.has(item.videoId)) return false;
      seen.add(item.videoId);
      return true;
    });

    // Enrich with inspect for tags and engagement when possible
    const enriched: TrendingVideo[] = [];
    const provenances: Provenance[] = [recentSearch.provenance, topSearch.provenance];

    const sliced = deduped.slice(0, maxResults);
    const inspectResults = await Promise.allSettled(
      sliced.map((item) =>
        this.inspectVideo({ videoIdOrUrl: item.videoId }, options),
      ),
    );

    for (let i = 0; i < sliced.length; i++) {
      const item = sliced[i];
      const inspectResult = inspectResults[i];
      const video: InspectVideoOutput | undefined =
        inspectResult.status === "fulfilled" ? inspectResult.value : undefined;
      if (video) {
        provenances.push(video.provenance);
      }

      enriched.push({
        videoId: item.videoId,
        title: video?.video.title ?? item.title,
        channelTitle: video?.video.channelTitle ?? item.channelTitle,
        publishedAt: video?.video.publishedAt ?? item.publishedAt,
        durationSec: video?.video.durationSec ?? item.durationSec,
        views: video?.stats.views ?? item.views,
        likes: video?.stats.likes,
        comments: video?.stats.comments,
        engagementRate: computeEngagementRate({
          views: video?.stats.views ?? item.views,
          likes: video?.stats.likes,
          comments: video?.stats.comments,
        }),
        viewVelocity24h: computeViewVelocity24h(
          video?.stats.views ?? item.views,
          video?.video.publishedAt ?? item.publishedAt,
        ),
        format: inferVideoFormat(video?.video.durationSec ?? item.durationSec),
        tags: video?.video.tags,
      });
    }

    // Sort by views descending for presentation
    enriched.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));

    // Compute trend signals
    const momentum = computeNicheMomentum(enriched, lookbackDays);
    const saturation = computeNicheSaturation(enriched);
    const contentGaps = detectContentGaps(enriched, niche);
    const formatBreakdown = computeFormatBreakdown(enriched);

    // Keywords and title patterns from enriched results
    const videoRecords = enriched.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      channelTitle: v.channelTitle,
      tags: v.tags,
      url: "",
    } as VideoRecord));
    const recurringKeywords = extractRecurringKeywords(videoRecords, 10);
    const titlePatterns = topStrings(
      enriched.map((v) => titleStructure(v.title)),
      6,
    );

    // Honest limitations
    limitations.push(
      "Trend signals are derived from YouTube search results, not internal YouTube trending data (which is not publicly available via API).",
    );
    limitations.push(
      `Momentum is estimated from ${enriched.length} sampled videos. Larger niches may need more sampling for precision.`,
    );
    if (!this.api.isConfigured()) {
      limitations.push(
        "Running without YOUTUBE_API_KEY — tag data and some engagement metrics may be missing from yt-dlp fallback.",
      );
    }
    if (enriched.length < 10) {
      limitations.push(
        `Only ${enriched.length} videos found. This may be a very narrow niche or the search terms need refinement.`,
      );
    }

    return {
      niche,
      regionCode: input.regionCode,
      trendingVideos: enriched.slice(0, maxResults),
      momentum,
      saturation,
      contentGaps,
      recurringKeywords,
      titlePatterns,
      formatBreakdown,
      limitations,
      provenance: this.mergeProvenances(provenances),
    };
  }

  async exploreNicheCompetitors(
    input: ExploreNicheCompetitorsInput,
    options: ServiceOptions = {},
  ): Promise<ExploreNicheCompetitorsOutput> {
    const niche = input.niche?.trim();
    if (!niche) {
      throw this.invalidInput("niche cannot be empty");
    }

    const maxChannels = clamp(input.maxChannels ?? 10, 3, 20);
    const limitations: string[] = [];

    // Search for top videos in the niche to discover active channels
    const search = await this.findVideos(
      {
        query: niche,
        maxResults: 25,
        order: "relevance",
        regionCode: input.regionCode,
      },
      options,
    );

    // Group by channel
    const channelMap = new Map<
      string,
      {
        channelTitle: string;
        channelId?: string;
        videos: Array<{ videoId: string; title: string; views?: number; engagementRate?: number }>;
      }
    >();

    for (const result of search.results) {
      const key = result.channelTitle;
      const current = channelMap.get(key) ?? {
        channelTitle: result.channelTitle,
        channelId: result.channelId,
        videos: [],
      };
      current.videos.push({
        videoId: result.videoId,
        title: result.title,
        views: result.views,
        engagementRate: result.engagementRate,
      });
      channelMap.set(key, current);
    }

    // Build competitor profiles
    const competitors: NicheCompetitor[] = [];
    const channelEntries = Array.from(channelMap.values())
      .sort((a, b) => {
        const aMax = Math.max(...a.videos.map((v) => v.views ?? 0));
        const bMax = Math.max(...b.videos.map((v) => v.views ?? 0));
        return bMax - aMax;
      })
      .slice(0, maxChannels);

    for (const entry of channelEntries) {
      const views = entry.videos.map((v) => v.views ?? 0).filter((v) => v > 0);
      const engagements = entry.videos.map((v) => v.engagementRate ?? 0).filter((v) => v > 0);
      const topVideo = [...entry.videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];

      let uploadFrequency: string | undefined;
      // Best-effort cadence estimate from search results is very rough
      if (entry.videos.length >= 2) {
        uploadFrequency = `${entry.videos.length} videos in search results (rough proxy)`;
      }

      competitors.push({
        channelId: entry.channelId,
        channelTitle: entry.channelTitle,
        videosSampled: entry.videos.length,
        medianViews: median(views),
        medianEngagementRate: median(engagements),
        estimatedUploadFrequency: uploadFrequency,
        topVideo: topVideo
          ? {
              videoId: topVideo.videoId,
              title: topVideo.title,
              views: topVideo.views,
            }
          : undefined,
      });
    }

    const allMedianViews = competitors
      .map((c) => c.medianViews ?? 0)
      .filter((v) => v > 0);
    const topPerformer = competitors[0];

    limitations.push(
      "Competitor discovery is based on YouTube search results for the niche query, not a comprehensive channel database.",
    );
    limitations.push(
      "Channels that rank for this niche but have diverse content may appear — verify niche relevance manually.",
    );
    if (search.results.length < 10) {
      limitations.push(
        `Only ${search.results.length} search results returned. The competitor landscape may be incomplete.`,
      );
    }

    return {
      niche,
      competitors,
      landscape: {
        totalChannelsSampled: competitors.length,
        medianViewsAcrossChannels: median(allMedianViews),
        topPerformerChannelTitle: topPerformer?.channelTitle,
      },
      limitations,
      provenance: search.provenance,
    };
  }

  // ── Explore module ──────────────────────────────────────────────

  async exploreYouTube(input: ExploreYouTubeInput, options: ServiceOptions = {}): Promise<ExploreYouTubeOutput> {
    if (!input.query && (!input.searches || input.searches.length === 0)) {
      throw this.invalidInput("Provide either 'query' or 'searches'.");
    }

    if (this.isDryRun(options)) {
      return this.sampleExploreYouTube(input);
    }

    // Build search queries
    const searches = input.searches?.length ? input.searches.slice(0, 5) : expandSearchQuery(input.query!);
    const maxResults = clamp(input.maxResults ?? (input.mode === "explore" ? 8 : 1), 1, 15);
    const mode: "specific" | "explore" = input.mode ?? (maxResults > 2 ? "explore" : "specific");
    const depth = input.depth ?? "standard";
    const strategy = input.selectionStrategy ?? (mode === "specific" ? "best_match" : "diverse_set");
    const publishedAfter = freshnessToDate(input.freshness);

    // Run all searches in parallel
    const searchResults = await Promise.all(
      searches.map((query) =>
        this.findVideos(
          {
            query,
            maxResults: 10,
            order: input.freshness === "week" || input.freshness === "month" ? "date" : "relevance",
            publishedAfter,
          },
          options,
        ).catch(() => null),
      ),
    );

    // Deduplicate candidates
    const seen = new Set<string>();
    const candidates: Array<{
      videoId: string;
      title: string;
      channelId?: string;
      channelTitle: string;
      publishedAt?: string;
      durationSec?: number;
      views?: number;
    }> = [];
    for (const result of searchResults) {
      if (!result) continue;
      for (const video of result.results) {
        if (!seen.has(video.videoId)) {
          seen.add(video.videoId);
          candidates.push(video);
        }
      }
    }

    if (candidates.length === 0) {
      return {
        mode,
        persona: input.persona,
        totalCandidatesEvaluated: 0,
        results: [],
        followUpHints: ["No videos found. Try broader search terms or remove the creator constraint."],
        limitations: ["All search queries returned zero results."],
        provenance: this.makeProvenance("none", true, ["No candidates found."]),
      };
    }

    // Score and rank
    const queryWords = extractQueryWords(searches);
    const scored = candidates.map((c) => ({
      candidate: c,
      score: scoreExploreCandidate(c, queryWords, input.creator),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Apply selection strategy
    const selected = strategy === "diverse_set"
      ? diverseSelect(scored, maxResults)
      : scored.slice(0, maxResults);

    // Enrich selected videos in parallel
    const enriched = await Promise.all(
      selected.map(async ({ candidate, score }, index) => {
        let likes: number | undefined;
        let transcriptAvailable = false;
        let keyMoments: ExploreYouTubeOutput["results"][number]["keyMoments"];

        try {
          const inspection = await this.inspectVideo({ videoIdOrUrl: candidate.videoId }, options);
          likes = inspection.stats.likes;
          if (inspection.stats.views != null) candidate.views = inspection.stats.views;
          transcriptAvailable = inspection.transcriptMeta?.available ?? false;
        } catch {
          // Use basic metadata from search
        }

        let transcriptSummary: string | undefined;

        if (depth !== "quick" && transcriptAvailable) {
          try {
            const transcript = await this.readTranscript(
              { videoIdOrUrl: candidate.videoId, mode: "key_moments" },
              options,
            );
            const segments = transcript.transcript.segments ?? [];
            const filtered = segments.filter((s) => s.topicLabel || s.text).slice(0, 8);
            keyMoments = filtered.map((s) => ({
              timestampSec: s.tStartSec,
              label: (s.topicLabel ?? s.text).slice(0, 100),
            }));
            // Include the actual transcript content so Claude doesn't need follow-up readTranscript calls
            transcriptSummary = filtered
              .map((s) => s.text)
              .filter(Boolean)
              .join(" ")
              .slice(0, 1200) || undefined;
          } catch {
            // Transcript unavailable — not an error
          }
        }

        return {
          rank: index + 1,
          selectionReason: buildExploreReason(candidate, score, input.creator, input.freshness),
          video: {
            videoId: candidate.videoId,
            title: candidate.title,
            channelTitle: candidate.channelTitle,
            publishedAt: candidate.publishedAt,
            durationSec: candidate.durationSec,
            views: candidate.views,
            likes,
          },
          keyMoments: keyMoments?.length ? keyMoments : undefined,
          transcriptSummary,
          transcriptSearchReady: false,
          visualSearchReady: false,
        };
      }),
    );

    // Background enrichment (fire-and-forget)
    let backgroundEnrichment: ExploreYouTubeOutput["backgroundEnrichment"];
    const topVideoIds = selected.map((s) => s.candidate.videoId);

    const shouldPrepareTranscripts = input.prepareTranscriptSearch ?? (depth === "standard" || depth === "deep");
    const shouldPrepareVisual = input.prepareVisualSearch ?? (depth !== "quick" && topVideoIds.length > 0);
    if (shouldPrepareTranscripts || shouldPrepareVisual) {
      const assetsBeingPrepared: string[] = [];

      if (shouldPrepareTranscripts) {
        assetsBeingPrepared.push("transcript_search");
        const collectionId = `explore-${topVideoIds[0]}`;
        void this.importVideos(
          { videoIdsOrUrls: topVideoIds.slice(0, 5), collectionId, activateCollection: true },
          options,
        ).catch(() => {});
      }

      if (shouldPrepareVisual) {
        assetsBeingPrepared.push("visual_search");
        // Only index the top result — downloading + extracting is expensive
        void this.indexVisualContent(
          { videoIdOrUrl: topVideoIds[0], autoDownload: true, downloadFormat: "worst_video" },
          options,
        ).catch(() => {});
      }

      if (assetsBeingPrepared.length > 0) {
        backgroundEnrichment = {
          status: "preparing",
          videosQueued: topVideoIds.slice(0, assetsBeingPrepared.includes("visual_search") ? 1 : 5),
          assetsBeingPrepared,
        };
      }
    }

    // Follow-up hints
    const followUpHints = buildExploreHints(enriched, backgroundEnrichment);

    // Provenance
    const provenances = searchResults.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.provenance);

    return {
      mode,
      persona: input.persona,
      totalCandidatesEvaluated: candidates.length,
      results: enriched,
      followUpHints,
      backgroundEnrichment,
      limitations: buildExploreLimitations(mode, depth, candidates.length),
      provenance: provenances.length > 0
        ? this.mergeProvenances(provenances)
        : this.makeProvenance("none", true),
    };
  }

  private sampleExploreYouTube(input: ExploreYouTubeInput): ExploreYouTubeOutput {
    const mode = input.mode ?? "specific";
    return {
      mode,
      persona: input.persona,
      totalCandidatesEvaluated: 12,
      results: [
        {
          rank: 1,
          selectionReason: "Best match: channel matches creator constraint, published 2 days ago, title directly matches search query.",
          video: {
            videoId: "dQw4w9WgXcQ",
            title: "Dry-run Sample Video — Explore Result",
            channelTitle: "Sample Creator",
            publishedAt: new Date().toISOString(),
            durationSec: 720,
            views: 150_000,
            likes: 8_500,
          },
          keyMoments: [
            { timestampSec: 0, label: "Introduction and overview" },
            { timestampSec: 120, label: "Core topic deep dive" },
            { timestampSec: 480, label: "Comparison and benchmarks" },
          ],
          transcriptSearchReady: false,
          visualSearchReady: false,
        },
      ],
      followUpHints: [
        "Dry-run mode: no real search was performed.",
      ],
      limitations: ["Dry-run sample only."],
      provenance: this.makeProvenance("none", false, ["Dry-run mode enabled."]),
    };
  }

  private async prepareKnowledgeBaseItems(
    videoIdsOrUrls: string[],
    config: {
      language?: string;
      chunkStrategy?: PlaylistKnowledgeBaseInput["chunkStrategy"];
      chunkSizeSec?: number;
      chunkOverlapSec?: number;
      reindexExisting?: boolean;
    },
    collectionId: string,
    options: ServiceOptions,
  ): Promise<{
    items: Array<{ video: VideoRecord; transcript: TranscriptRecord; options: { strategy: "auto" | "chapters" | "time_window"; chunkSizeSec: number; chunkOverlapSec: number } }>;
    skipped: number;
    failures: Array<{ videoId: string; reason: string }>;
    totalRequested: number;
  }> {
    const items: Array<{ video: VideoRecord; transcript: TranscriptRecord; options: { strategy: "auto" | "chapters" | "time_window"; chunkSizeSec: number; chunkOverlapSec: number } }> = [];
    const seen = new Set<string>();
    const failures: Array<{ videoId: string; reason: string }> = [];
    let skipped = 0;

    for (const raw of videoIdsOrUrls) {
      let videoId: string;
      try {
        videoId = this.requireVideoId(raw);
      } catch (error) {
        failures.push({
          videoId: raw,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (seen.has(videoId)) {
        skipped += 1;
        continue;
      }
      seen.add(videoId);

      if (!config.reindexExisting && this.knowledgeBase.hasVideo(collectionId, videoId)) {
        skipped += 1;
        continue;
      }

      try {
        const [video, transcript] = await Promise.all([
          this.fetchVideoInfoForIndexing(videoId, options),
          this.fetchTranscriptForIndexing(videoId, config.language, options),
        ]);

        items.push({
          video,
          transcript,
          options: {
            strategy: (config.chunkStrategy ?? "auto") as "auto" | "chapters" | "time_window",
            chunkSizeSec: clamp(config.chunkSizeSec ?? 120, 30, 900),
            chunkOverlapSec: clamp(config.chunkOverlapSec ?? 30, 0, 300),
          },
        });
      } catch (error) {
        failures.push({
          videoId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      items,
      skipped,
      failures,
      totalRequested: videoIdsOrUrls.length,
    };
  }

  private async fetchVideoInfoForIndexing(videoId: string, options: ServiceOptions): Promise<VideoRecord> {
    const resolved = await this.executeFallback(
      {
        youtube_api: () => this.api.getVideoInfo(videoId),
        yt_dlp: () => this.ytdlp.videoInfo(videoId),
        page_extract: () => this.pageExtract.getVideoInfo(videoId),
      },
      this.sampleVideo(videoId),
      options,
      { partialTiers: ["page_extract"] },
    );
    return resolved.data;
  }

  private async fetchTranscriptForIndexing(videoId: string, language: string | undefined, options: ServiceOptions): Promise<TranscriptRecord> {
    const resolved = await this.executeFallback(
      {
        yt_dlp: () => this.ytdlp.transcript(videoId, language),
      },
      this.sampleTranscript(videoId),
      options,
      { partialTiers: [] },
    );
    return resolved.data;
  }

  private defaultVideoCollectionId(input: VideoKnowledgeBaseInput): string {
    if (input.collectionId) {
      return input.collectionId;
    }
    const fingerprint = input.videoIdsOrUrls
      .slice(0, 50)
      .map((item) => this.requireVideoId(item))
      .join("-")
      .slice(0, 48);
    const base = (input.label ?? "videos")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "videos";
    return `${base}-${fingerprint}`;
  }

  private async analyzeSingleVideo(
    videoId: string,
    analyses: VideoAnalysisMode[],
    config: { commentsSampleSize: number; transcriptMode: "summary" | "key_moments" | "full" },
    options: ServiceOptions,
  ): Promise<AnalyzeVideoSetItem> {
    const item: AnalyzeVideoSetItem = {
      videoId,
      analyses: {},
      errors: [],
      provenance: this.makeProvenance("none", false),
    };
    const provenances: Provenance[] = [];

    let cachedVideoInfo: InspectVideoOutput | undefined;
    let cachedTranscript: ReadTranscriptOutput | undefined;
    let cachedComments: ReadCommentsOutput | undefined;

    for (const analysis of analyses) {
      try {
        if (analysis === "video_info") {
          cachedVideoInfo = cachedVideoInfo ?? (await this.inspectVideo({ videoIdOrUrl: videoId }, options));
          item.analyses.videoInfo = cachedVideoInfo;
          provenances.push(cachedVideoInfo.provenance);
        } else if (analysis === "transcript") {
          cachedTranscript = cachedTranscript ??
            (await this.readTranscript({ videoIdOrUrl: videoId, mode: config.transcriptMode }, options));
          item.analyses.transcript = cachedTranscript;
          provenances.push(cachedTranscript.provenance);
        } else if (analysis === "comments") {
          cachedComments = cachedComments ??
            (await this.readComments({ videoIdOrUrl: videoId, maxTopLevel: config.commentsSampleSize }, options));
          item.analyses.comments = cachedComments;
          provenances.push(cachedComments.provenance);
        } else if (analysis === "sentiment") {
          const sentiment = await this.measureAudienceSentiment(
            { videoIdOrUrl: videoId, sampleSize: config.commentsSampleSize },
            options,
          );
          item.analyses.sentiment = sentiment;
          provenances.push(sentiment.provenance);
        } else if (analysis === "hook_patterns") {
          cachedTranscript = cachedTranscript ??
            (await this.readTranscript({ videoIdOrUrl: videoId, mode: "full", limit: 12000 }, options));
          const transcriptRecord: TranscriptRecord = {
            videoId,
            languageUsed: cachedTranscript.languageUsed,
            sourceType: cachedTranscript.quality.sourceType,
            confidence: cachedTranscript.quality.confidence,
            transcriptText: cachedTranscript.transcript.text ?? cachedTranscript.transcript.segments?.map((segment) => segment.text).join(" ") ?? "",
            segments: cachedTranscript.transcript.segments?.map((segment) => ({
              tStartSec: segment.tStartSec,
              tEndSec: segment.tEndSec,
              text: segment.text,
            })) ?? [],
            chapters: cachedTranscript.chapters,
          };
          const hook = scoreHookPattern(videoId, transcriptRecord, 30);
          item.analyses.hookPatterns = {
            hookScore: hook.hookScore,
            hookType: hook.hookType,
            first30SecSummary: hook.first30SecSummary,
          };
          provenances.push(cachedTranscript.provenance);
        } else if (analysis === "tag_title_patterns") {
          cachedVideoInfo = cachedVideoInfo ?? (await this.inspectVideo({ videoIdOrUrl: videoId }, options));
          item.analyses.tagTitlePatterns = {
            recurringKeywords: extractRecurringKeywords([
              {
                videoId,
                title: cachedVideoInfo.video.title,
                channelId: cachedVideoInfo.video.channelId,
                channelTitle: cachedVideoInfo.video.channelTitle,
                publishedAt: cachedVideoInfo.video.publishedAt,
                durationSec: cachedVideoInfo.video.durationSec,
                views: cachedVideoInfo.stats.views,
                likes: cachedVideoInfo.stats.likes,
                comments: cachedVideoInfo.stats.comments,
                tags: cachedVideoInfo.video.tags,
                language: cachedVideoInfo.video.language,
                category: cachedVideoInfo.video.category,
                url: "",
              },
            ]),
            titleStructure: [titleStructure(cachedVideoInfo.video.title)],
          };
          provenances.push(cachedVideoInfo.provenance);
        }
      } catch (error) {
        item.errors?.push(this.normalizeError(error));
      }
    }

    item.errors = item.errors && item.errors.length > 0 ? item.errors : undefined;
    item.provenance = provenances.length > 0
      ? this.mergeProvenances(provenances, Boolean(item.errors?.length))
      : this.makeProvenance("none", true, ["No requested analyses completed successfully."]);
    return item;
  }

  private async resolveChannel(
    ref: ChannelRef,
    options: ServiceOptions,
  ): Promise<{ data: ChannelRecord; provenance: Provenance }> {
    return this.withCache(
      "channel_meta",
      "resolveChannel",
      { channelRef: this.stringifyChannelRef(ref) },
      options,
      () => this.executeFallback(
        {
          youtube_api: () => this.api.getChannel(ref),
          yt_dlp: () => this.ytdlp.channel(ref),
          page_extract: () => this.pageExtract.getChannelInfo(ref),
        },
        this.sampleChannel(ref),
        options,
        { partialTiers: ["page_extract"] },
      ),
    );
  }

  private async bestEffortChannelCadence(
    ref: ChannelRef,
    options: ServiceOptions,
  ): Promise<{
    data: InspectChannelOutput["cadence"];
    provenance: Provenance;
  }> {
    try {
      const catalog = await this.resolveChannelVideos(ref, 30, "UC_x5XG1OV2P6uZZ5FSM9Ttw", options);

      const dates = catalog.data
        .map((video) => video.publishedAt)
        .filter((value): value is string => Boolean(value))
        .map((value) => new Date(value))
        .filter((date) => !Number.isNaN(date.getTime()))
        .sort((a, b) => b.getTime() - a.getTime());

      const now = Date.now();
      const uploadsLast30d = dates.filter((date) => now - date.getTime() <= 30 * 86_400_000).length;
      const uploadsLast90d = dates.filter((date) => now - date.getTime() <= 90 * 86_400_000).length;
      const intervals: number[] = [];
      for (let index = 0; index < dates.length - 1; index += 1) {
        intervals.push((dates[index].getTime() - dates[index + 1].getTime()) / 86_400_000);
      }

      return {
        data: {
          uploadsLast30d,
          uploadsLast90d,
          medianDaysBetweenUploads: median(intervals),
        },
        provenance: catalog.provenance,
      };
    } catch (error) {
      return {
        data: {},
        provenance: this.makeProvenance("none", true, [`Cadence unavailable: ${toMessage(error)}`]),
      };
    }
  }

  private async resolveVideoInfo(
    videoId: string,
    options: ServiceOptions,
  ): Promise<{ data: VideoRecord; provenance: Provenance }> {
    return this.withCache(
      "video_meta",
      "resolveVideoInfo",
      { videoId },
      options,
      () => this.executeFallback(
        {
          youtube_api: () => this.api.getVideoInfo(videoId),
          yt_dlp: () => this.ytdlp.videoInfo(videoId),
          page_extract: () => this.pageExtract.getVideoInfo(videoId),
        },
        this.sampleVideo(videoId),
        options,
        { partialTiers: ["page_extract"] },
      ),
    );
  }

  private async resolveTranscript(
    videoId: string,
    language: string | undefined,
    options: ServiceOptions,
  ): Promise<{ data: TranscriptRecord; provenance: Provenance }> {
    return this.withCache(
      "transcript",
      "resolveTranscript",
      { videoId, language: language ?? null },
      options,
      () => this.executeFallback(
        {
          yt_dlp: () => this.ytdlp.transcript(videoId, language),
        },
        this.sampleTranscript(videoId),
        options,
        { partialTiers: [] },
      ),
    );
  }

  private async resolveComments(
    videoId: string,
    maxTopLevel: number,
    order: "relevance" | "time",
    includeReplies: boolean,
    maxRepliesPerThread: number,
    options: ServiceOptions,
  ): Promise<{ data: CommentRecord[]; provenance: Provenance }> {
    return this.withCache(
      "comments",
      "resolveComments",
      {
        videoId,
        maxTopLevel,
        order,
        includeReplies,
        maxRepliesPerThread,
      },
      options,
      () => this.executeFallback(
        {
          youtube_api: () =>
            this.api.getVideoComments(videoId, maxTopLevel, order, includeReplies, maxRepliesPerThread),
          yt_dlp: () => this.ytdlp.comments(videoId, maxTopLevel),
        },
        this.sampleComments(videoId),
        options,
        { partialTiers: includeReplies ? ["yt_dlp"] : [] },
      ),
    );
  }

  private async resolveChannelVideos(
    ref: ChannelRef,
    maxResults: number,
    sampleChannelId: string,
    options: ServiceOptions,
  ): Promise<{ data: VideoRecord[]; provenance: Provenance }> {
    return this.withCache(
      "channel_meta",
      "resolveChannelVideos",
      {
        channelRef: this.stringifyChannelRef(ref),
        maxResults,
      },
      options,
      () => this.executeFallback(
        {
          youtube_api: () => this.api.listChannelVideos(ref, maxResults),
          yt_dlp: () => this.ytdlp.channelVideos(ref, maxResults),
        },
        this.sampleChannelVideos(sampleChannelId),
        options,
        { partialTiers: ["yt_dlp"] },
      ),
    );
  }

  private async withCache<T>(
    entityType: CacheEntityType,
    scope: string,
    inputs: Record<string, unknown>,
    options: ServiceOptions,
    load: () => Promise<T>,
  ): Promise<T> {
    if (this.isDryRun(options)) {
      return load();
    }

    const key = buildCacheKey(scope, inputs);
    const cached = this.cacheStore.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await load();
    this.cacheStore.set(key, entityType, value);
    return value;
  }

  private stringifyChannelRef(ref: ChannelRef): string {
    if (ref.type === "id") return `id:${ref.value}`;
    if (ref.type === "handle") return `handle:${ref.value.toLowerCase()}`;
    return `url:${ref.value}`;
  }

  private filterAndSortCatalog(
    videos: VideoRecord[],
    options: {
      sortBy?: ListChannelCatalogInput["sortBy"];
      includeShorts: boolean;
      includeLongForm: boolean;
      publishedWithinDays?: number;
    },
  ): VideoRecord[] {
    let filtered = [...videos];
    if (options.publishedWithinDays) {
      const boundary = Date.now() - options.publishedWithinDays * 86_400_000;
      filtered = filtered.filter((video) => {
        if (!video.publishedAt) {
          return false;
        }
        const published = new Date(video.publishedAt).getTime();
        return !Number.isNaN(published) && published >= boundary;
      });
    }

    filtered = filtered.filter((video) => {
      const format = inferVideoFormat(video.durationSec);
      if (format === "short") {
        return options.includeShorts;
      }
      if (format === "long") {
        return options.includeLongForm;
      }
      return true;
    });

    const sortBy = options.sortBy ?? "date_desc";
    filtered.sort((a, b) => {
      if (sortBy === "views_desc") {
        return (b.views ?? 0) - (a.views ?? 0);
      }
      const left = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const right = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return sortBy === "date_asc" ? left - right : right - left;
    });

    return filtered;
  }

  private async executeFallback<T>(
    actions: Partial<Record<Exclude<SourceTier, "none">, () => Promise<T>>>,
    dryRunData: T,
    options: ServiceOptions,
    config: { partialTiers?: SourceTier[] } = {},
  ): Promise<{ data: T; provenance: Provenance }> {
    if (this.isDryRun(options)) {
      return {
        data: dryRunData,
        provenance: this.makeProvenance("none", false, ["Dry-run mode enabled. No external calls were made."]),
      };
    }

    const attempted: SourceTier[] = [];
    const notes: string[] = [];
    const orderedTiers: Exclude<SourceTier, "none">[] = ["youtube_api", "yt_dlp", "page_extract"];

    for (const tier of orderedTiers) {
      const action = actions[tier];
      if (!action) {
        continue;
      }
      if (tier === "youtube_api" && !this.api.isConfigured()) {
        notes.push("youtube_api skipped: YOUTUBE_API_KEY not configured.");
        continue;
      }

      attempted.push(tier);
      try {
        const data = await action();
        return {
          data,
          provenance: this.makeProvenance(tier, config.partialTiers?.includes(tier) ?? tier === "page_extract", notes),
        };
      } catch (error) {
        notes.push(`${tier} failed: ${toMessage(error)}`);
      }
    }

    throw new ToolExecutionError({
      code: "UPSTREAM_UNAVAILABLE",
      message: "All available source tiers failed for this request.",
      retryable: true,
      attemptedTiers: attempted,
      suggestion: "Try again later, provide an API key for higher fidelity, or choose a public video/channel with captions enabled.",
    });
  }

  private isDryRun(options: ServiceOptions): boolean {
    return this.dryRun || Boolean(options.dryRun);
  }

  private requireVideoId(input: string): string {
    const videoId = parseVideoId(input);
    if (!videoId) {
      throw this.invalidInput("Could not extract a valid YouTube video ID from input.");
    }
    return videoId;
  }

  private requireChannelRef(input: string): ChannelRef {
    const ref = parseChannelRef(input);
    if (!ref) {
      throw this.invalidInput("Channel input cannot be empty.");
    }
    return ref;
  }

  private requirePlaylistId(input: string): string {
    const playlistId = parsePlaylistId(input);
    if (!playlistId) {
      throw this.invalidInput("Could not extract a valid YouTube playlist ID from input.");
    }
    return playlistId;
  }

  private invalidInput(message: string): ToolExecutionError {
    return new ToolExecutionError(this.invalidInputDetail(message));
  }

  private invalidInputDetail(message: string): GracefulError {
    return {
      code: "INVALID_INPUT",
      message,
      retryable: false,
      attemptedTiers: [],
      suggestion: "Provide a valid YouTube URL, ID, handle, or playlist reference.",
    };
  }

  private normalizeError(error: unknown): GracefulError {
    if (error instanceof ToolExecutionError) {
      return error.detail;
    }
    return {
      code: "INTERNAL_ERROR",
      message: toMessage(error),
      retryable: false,
      attemptedTiers: [],
    };
  }

  private makeProvenance(sourceTier: SourceTier, partial: boolean, sourceNotes?: string[]): Provenance {
    return {
      sourceTier,
      fetchedAt: new Date().toISOString(),
      fallbackDepth: FALLBACK_DEPTH[sourceTier],
      partial,
      sourceNotes: sourceNotes && sourceNotes.length > 0 ? sourceNotes : undefined,
    };
  }

  private mergeProvenances(provenances: Provenance[], forcePartial = false): Provenance {
    const existing = provenances.filter(Boolean);
    if (existing.length === 0) {
      return this.makeProvenance("none", true);
    }

    const worst = existing.reduce((current, candidate) =>
      candidate.fallbackDepth > current.fallbackDepth ? candidate : current,
    );

    return {
      sourceTier: worst.sourceTier,
      fetchedAt: existing[0]?.fetchedAt ?? new Date().toISOString(),
      fallbackDepth: worst.fallbackDepth,
      partial: forcePartial || existing.some((item) => item.partial),
      sourceNotes: existing.flatMap((item) => item.sourceNotes ?? []).slice(0, 12),
    };
  }

  private sampleSearch(query: string, maxResults: number): VideoRecord[] {
    return Array.from({ length: Math.min(maxResults, 3) }, (_, index) => ({
      videoId: `dryRunVid${index}`.padEnd(11, "0").slice(0, 11),
      title: `${query} result ${index + 1}`,
      channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      channelTitle: "vidlens-mcp",
      publishedAt: "2026-03-01T10:00:00.000Z",
      durationSec: 420 + index * 60,
      views: 10000 - index * 500,
      likes: 500 - index * 20,
      comments: 40 - index * 5,
      tags: ["youtube", "mcp", query],
      description: "Dry-run video record",
      transcriptAvailable: true,
      transcriptLanguages: ["en"],
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    }));
  }

  private sampleVideo(videoId: string): VideoRecord {
    return {
      videoId,
      title: "Dry-run sample video",
      channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      channelTitle: "vidlens-mcp",
      publishedAt: "2026-03-01T10:00:00.000Z",
      durationSec: 642,
      views: 125000,
      likes: 5600,
      comments: 412,
      tags: ["mcp", "youtube", "analysis"],
      language: "en",
      category: "Education",
      description: "0:00 Intro\n1:12 Problem\n4:40 Solution\n8:30 Wrap up",
      chapters: parseDescriptionChapters("0:00 Intro\n1:12 Problem\n4:40 Solution\n8:30 Wrap up"),
      transcriptAvailable: true,
      transcriptLanguages: ["en"],
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  private sampleChannel(ref: ChannelRef): ChannelRecord {
    const handle = ref.type === "handle" ? ref.value : "GoogleDevelopers";
    return {
      channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      title: "Dry-run channel",
      handle,
      createdAt: "2010-01-01T00:00:00.000Z",
      country: "US",
      description: "Dry-run channel description for demo purposes.",
      descriptionSummary: "Dry-run channel description for demo purposes.",
      subscribers: 1200000,
      totalViews: 56000000,
      totalVideos: 540,
      url: "https://www.youtube.com/@GoogleDevelopers",
    };
  }

  private sampleChannelVideos(channelId: string): VideoRecord[] {
    return [
      {
        videoId: "dryrun00001",
        title: "Hook patterns that convert",
        channelId,
        channelTitle: "Dry-run channel",
        publishedAt: "2026-03-09T08:00:00.000Z",
        durationSec: 45,
        views: 42000,
        likes: 2600,
        comments: 190,
        tags: ["hooks", "shorts"],
        url: "https://www.youtube.com/watch?v=dryrun00001",
      },
      {
        videoId: "dryrun00002",
        title: "Title research workflow",
        channelId,
        channelTitle: "Dry-run channel",
        publishedAt: "2026-03-05T08:00:00.000Z",
        durationSec: 720,
        views: 18000,
        likes: 920,
        comments: 80,
        tags: ["titles", "seo"],
        url: "https://www.youtube.com/watch?v=dryrun00002",
      },
      {
        videoId: "dryrun00003",
        title: "Audience sentiment breakdown",
        channelId,
        channelTitle: "Dry-run channel",
        publishedAt: "2026-02-25T08:00:00.000Z",
        durationSec: 510,
        views: 22000,
        likes: 1100,
        comments: 95,
        tags: ["comments", "sentiment"],
        url: "https://www.youtube.com/watch?v=dryrun00003",
      },
    ];
  }

  private sampleTranscript(videoId: string): TranscriptRecord {
    return {
      videoId,
      languageUsed: "en",
      sourceType: "manual_caption",
      confidence: 0.93,
      transcriptText:
        "Today I'm going to show you how to research YouTube titles that actually earn clicks without resorting to clickbait. We'll look at patterns, compare examples, and leave with a checklist you can reuse.",
      segments: [
        { tStartSec: 0, tEndSec: 9, text: "Today I'm going to show you how to research YouTube titles that actually earn clicks without resorting to clickbait." },
        { tStartSec: 9, tEndSec: 18, text: "We'll look at patterns, compare examples, and leave with a checklist you can reuse." },
        { tStartSec: 18, tEndSec: 34, text: "First, start by mapping titles that use a clear promise, proof point, or surprising contrast." },
        { tStartSec: 34, tEndSec: 52, text: "Then compare the opening hook and audience comments to see whether the title matched the payoff." },
      ],
      chapters: [
        { title: "Intro", tStartSec: 0, tEndSec: 18 },
        { title: "Pattern map", tStartSec: 18, tEndSec: 52 },
      ],
    };
  }

  private sampleComments(videoId: string): CommentRecord[] {
    return [
      {
        commentId: "comment-1",
        author: "Builder One",
        text: "Great breakdown. Super clear and helpful.",
        likeCount: 12,
        publishedAt: "2026-03-01T10:00:00.000Z",
      },
      {
        commentId: "comment-2",
        author: "Builder Two",
        text: "Useful examples. The pacing felt a little slow in the middle but overall excellent.",
        likeCount: 7,
        publishedAt: "2026-03-01T11:00:00.000Z",
      },
      {
        commentId: "comment-3",
        author: "Builder Three",
        text: "Love the practical checklist. This is the best explanation I've found.",
        likeCount: 5,
        publishedAt: "2026-03-01T12:00:00.000Z",
      },
    ];
  }

  private samplePlaylist(playlistId: string): {
    playlistId: string;
    title?: string;
    channelTitle?: string;
    videoCountReported?: number;
    videos: VideoRecord[];
  } {
    return {
      playlistId,
      title: "Dry-run playlist",
      channelTitle: "vidlens-mcp",
      videoCountReported: 3,
      videos: this.sampleChannelVideos("UC_x5XG1OV2P6uZZ5FSM9Ttw"),
    };
  }

  private sampleImportReadiness(videoId: string): CheckImportReadinessOutput {
    const transcript = this.sampleTranscript(videoId);
    return {
      videoId,
      title: this.sampleVideo(videoId).title,
      importReadiness: {
        canImport: true,
        status: "ready",
        summary: "Dry-run transcript is importable and should chunk normally for semantic search.",
        suggestedCollectionId: TranscriptKnowledgeBase.videosCollectionId({ videoIdsOrUrls: [videoId] }),
      },
      transcript: {
        available: true,
        sourceType: transcript.sourceType,
        languageUsed: transcript.languageUsed,
        segmentCount: transcript.segments.length,
        transcriptCharacters: transcript.transcriptText.length,
        sparseTranscript: false,
        estimatedSearchableChunks: estimateTranscriptChunks(transcript),
      },
      checks: [
        { name: "youtube_api_metadata", status: "skipped", detail: "Dry-run mode enabled." },
        { name: "yt_dlp_binary", status: "ok", detail: "Dry-run assumes yt-dlp is available." },
        { name: "yt_dlp_transcript", status: "ok", detail: "Dry-run transcript probe succeeded." },
      ],
      suggestions: [],
      provenance: this.makeProvenance("none", false, ["Dry-run mode enabled. No external calls were made."]),
    };
  }

  private sampleSystemHealth(): CheckSystemHealthOutput {
    const packageMeta = readPackageMetadata();
    return {
      overallStatus: "ready",
      dataDir: this.knowledgeBase.dataDir,
      runtime: {
        nodeVersion: process.version,
        packageName: packageMeta.name,
        packageVersion: packageMeta.version,
      },
      keys: {
        youtubeApiConfigured: Boolean(process.env.YOUTUBE_API_KEY),
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      },
      clients: detectKnownClients(),
      checks: [
        { name: "yt_dlp", status: "ok", detail: "Dry-run assumes yt-dlp is available." },
        { name: "youtube_api", status: "skipped", detail: "Dry-run skipped live API validation." },
        { name: "gemini_embeddings", status: "skipped", detail: "Dry-run skipped live Gemini validation." },
        { name: "storage", status: "ok", detail: `Dry-run data directory available (${this.knowledgeBase.dataDir}).` },
      ],
      suggestions: [],
      provenance: this.makeProvenance("none", false, ["Dry-run mode enabled. No external calls were made."]),
    };
  }

  private sampleVisualIndex(videoId: string): IndexVisualContentOutput {
    return {
      videoId,
      sourceVideo: {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: "Dry-run sample video",
        localVideoPath: join(this.mediaStore.videoDir(videoId), `${videoId}.mp4`),
      },
      indexing: {
        framesExtracted: 3,
        framesAnalyzed: 3,
        framesIndexed: 3,
        intervalSec: 20,
        maxFrames: 3,
        autoDownloaded: true,
        descriptionProvider: "gemini",
        descriptionModel: process.env.VIDLENS_GEMINI_VISION_MODEL || "gemini-2.5-flash",
        embeddingProvider: "gemini",
        embeddingModel: process.env.YOUTUBE_MCP_GEMINI_MODEL || "gemini-embedding-2-preview",
        embeddingDimensions: 768,
      },
      evidence: [
        {
          frameAssetId: `dry-frame-${videoId}-1`,
          framePath: join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0000_0s.jpg`),
          timestampSec: 0,
          timestampLabel: "0:00",
          ocrText: "TITLE RESEARCH CHECKLIST",
          visualDescription: "A presentation slide with the heading TITLE RESEARCH CHECKLIST and three bullet points.",
        },
        {
          frameAssetId: `dry-frame-${videoId}-2`,
          framePath: join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0001_20s.jpg`),
          timestampSec: 20,
          timestampLabel: "0:20",
          ocrText: "promise proof contrast",
          visualDescription: "A whiteboard-style frame showing a three-column framework: promise, proof, contrast.",
        },
        {
          frameAssetId: `dry-frame-${videoId}-3`,
          framePath: join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0002_40s.jpg`),
          timestampSec: 40,
          timestampLabel: "0:40",
          ocrText: "compare opening hook comments",
          visualDescription: "A browser screenshot comparing opening hooks and comment sentiment side by side.",
        },
      ],
      limitations: [
        "Dry-run sample: no real frames were extracted.",
        "Real mode uses Apple Vision OCR and optional Gemini frame descriptions.",
      ],
      provenance: this.makeProvenance("none", false, ["Dry-run mode enabled. No external calls were made."]),
    };
  }

  private sampleVisualSearch(query: string, videoId = "dQw4w9WgXcQ"): SearchVisualContentOutput {
    return {
      query,
      results: [
        {
          score: 0.91,
          lexicalScore: 0.82,
          semanticScore: 0.95,
          matchedOn: ["ocr", "description", "semantic"],
          videoId,
          sourceVideoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          sourceVideoTitle: "Dry-run sample video",
          frameAssetId: `dry-frame-${videoId}-2`,
          framePath: join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0001_20s.jpg`),
          timestampSec: 20,
          timestampLabel: "0:20",
          explanation: "OCR matched: promise proof contrast • Visual description matched: A whiteboard-style frame showing a three-column framework: promise, proof, contrast. • Gemini semantic retrieval matched frame text.",
          ocrText: "promise proof contrast",
          visualDescription: "A whiteboard-style frame showing a three-column framework: promise, proof, contrast.",
        },
        {
          score: 0.72,
          lexicalScore: 0.55,
          semanticScore: 0.81,
          matchedOn: ["description", "semantic"],
          videoId,
          sourceVideoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          sourceVideoTitle: "Dry-run sample video",
          frameAssetId: `dry-frame-${videoId}-3`,
          framePath: join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0002_40s.jpg`),
          timestampSec: 40,
          timestampLabel: "0:40",
          explanation: "Visual description matched: A browser screenshot comparing opening hooks and comment sentiment side by side. • Gemini semantic retrieval matched frame text.",
          ocrText: "compare opening hook comments",
          visualDescription: "A browser screenshot comparing opening hooks and comment sentiment side by side.",
        },
      ],
      searchMeta: {
        searchedFrames: 3,
        searchedVideos: 1,
        descriptionProvider: "gemini",
        embeddingProvider: "gemini",
        embeddingModel: process.env.YOUTUBE_MCP_GEMINI_MODEL || "gemini-embedding-2-preview",
        queryMode: "gemini_semantic_plus_lexical",
      },
      coveredTimeRange: { startSec: 0, endSec: 120 },
      needsExpansion: false,
      limitations: [
        "Dry-run sample only. Real mode returns actual local frame paths as evidence.",
      ],
      provenance: this.makeProvenance("none", false, ["Dry-run mode enabled. No external calls were made."]),
    };
  }

  private sampleSimilarFrames(assetId?: string, framePath?: string): FindSimilarFramesOutput {
    const videoId = "dQw4w9WgXcQ";
    return {
      reference: {
        assetId,
        framePath: framePath ?? join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0001_20s.jpg`),
        videoId,
      },
      results: [
        {
          similarity: 0.943,
          videoId,
          sourceVideoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          sourceVideoTitle: "Dry-run sample video",
          frameAssetId: `dry-frame-${videoId}-3`,
          framePath: join(this.mediaStore.videoDir(videoId), "keyframes", `${videoId}_0002_40s.jpg`),
          timestampSec: 40,
          timestampLabel: "0:40",
          explanation: "Apple Vision feature-print similarity 0.943 • A browser screenshot comparing opening hooks and comment sentiment side by side.",
          ocrText: "compare opening hook comments",
          visualDescription: "A browser screenshot comparing opening hooks and comment sentiment side by side.",
        },
      ],
      searchMeta: {
        searchedFrames: 3,
        similarityEngine: "apple_vision_feature_print",
      },
      limitations: [
        "Dry-run sample only. Real mode computes similarity from the reference image itself.",
      ],
      provenance: this.makeProvenance("none", false, ["Dry-run mode enabled. No external calls were made."]),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatTimestamp(value: number): string {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function rate(primary: number | undefined, secondary: number | undefined, denominator: number | undefined): number | undefined {
  if (!denominator || denominator <= 0) {
    return undefined;
  }
  const numerator = (primary ?? 0) + (secondary ?? 0);
  return round((numerator / denominator) * 100, 2);
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toMessage(error: unknown): string {
  if (error instanceof ToolExecutionError) {
    return error.detail.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function topStrings(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function dedupeStrings(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function isSparseTranscript(transcript: TranscriptRecord): boolean {
  const text = transcript.transcriptText.replace(/\s+/g, " ").trim();
  const tokenCount = text.split(/\s+/).filter(Boolean).length;
  return text.length < 200 || tokenCount < 40 || transcript.segments.length <= 2;
}

function estimateTranscriptChunks(transcript: TranscriptRecord): number {
  if (transcript.segments.length === 0) {
    return 0;
  }
  if (isSparseTranscript(transcript)) {
    return 1;
  }
  const firstStart = transcript.segments[0]?.tStartSec ?? 0;
  const lastEnd = transcript.segments[transcript.segments.length - 1]?.tEndSec ?? firstStart;
  const duration = Math.max(1, lastEnd - firstStart);
  return Math.max(1, Math.ceil(duration / 120));
}

/* ── Explore helpers ─────────────────────────────────────────── */

function expandSearchQuery(query: string): string[] {
  const year = new Date().getFullYear();
  const searches = [query];
  if (!/\b20\d{2}\b/.test(query)) {
    searches.push(`${query} ${year}`);
  }
  return searches;
}

function freshnessToDate(freshness?: string): string | undefined {
  const daysMap: Record<string, number> = { week: 7, month: 30, year: 365 };
  const days = freshness ? daysMap[freshness] : undefined;
  if (!days) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function extractQueryWords(searches: string[]): string[] {
  const words = new Set<string>();
  for (const s of searches) {
    for (const w of s.toLowerCase().split(/\W+/)) {
      if (w.length > 2) words.add(w);
    }
  }
  return [...words];
}

function scoreExploreCandidate(
  candidate: { title: string; channelTitle: string; publishedAt?: string; durationSec?: number; views?: number },
  queryWords: string[],
  creator?: string,
): number {
  let score = 0;
  const hasCreator = Boolean(creator);

  // Title relevance (0-1)
  const titleWords = new Set(candidate.title.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const titleOverlap = queryWords.length > 0
    ? queryWords.filter((w) => titleWords.has(w)).length / queryWords.length
    : 0;

  // Creator match (0-1)
  let creatorScore = 0;
  if (creator) {
    const cn = creator.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ch = candidate.channelTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ch === cn || ch.includes(cn) || cn.includes(ch)) creatorScore = 1;
  }

  // Freshness (0-1) — decay over 90 days
  let freshnessScore = 0.5;
  if (candidate.publishedAt) {
    const ageMs = Date.now() - new Date(candidate.publishedAt).getTime();
    const ageDays = Math.max(0, ageMs / 86_400_000);
    freshnessScore = Math.max(0, 1 - ageDays / 90);
  }

  // View velocity (0-1) — views per day, normalized loosely
  let velocityScore = 0;
  if (candidate.views && candidate.publishedAt) {
    const ageDays = Math.max(1, (Date.now() - new Date(candidate.publishedAt).getTime()) / 86_400_000);
    const vpd = candidate.views / ageDays;
    velocityScore = Math.min(1, vpd / 10_000); // 10k views/day = max score
  }

  // Duration fit (0-1) — penalize very short (<2min) and very long (>2h)
  let durationFit = 1;
  if (candidate.durationSec != null) {
    if (candidate.durationSec < 120) durationFit = 0.3;
    else if (candidate.durationSec > 7200) durationFit = 0.5;
  }

  if (hasCreator) {
    score = creatorScore * 0.35 + titleOverlap * 0.25 + freshnessScore * 0.20 + velocityScore * 0.10 + durationFit * 0.10;
  } else {
    score = titleOverlap * 0.40 + freshnessScore * 0.25 + velocityScore * 0.15 + durationFit * 0.10 + 0.10; // transcript availability bonus (assumed)
  }

  return score;
}

function diverseSelect<T extends { candidate: { channelTitle: string }; score: number }>(
  scored: T[],
  maxResults: number,
): T[] {
  const result: T[] = [];
  const channelCounts = new Map<string, number>();

  for (const item of scored) {
    if (result.length >= maxResults) break;
    const ch = item.candidate.channelTitle.toLowerCase();
    const count = channelCounts.get(ch) ?? 0;
    if (count >= 2) continue;
    channelCounts.set(ch, count + 1);
    result.push(item);
  }

  return result;
}

function buildExploreReason(
  candidate: { title: string; channelTitle: string; publishedAt?: string; views?: number },
  score: number,
  creator?: string,
  freshness?: string,
): string {
  const parts: string[] = [];

  if (creator) {
    const cn = creator.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ch = candidate.channelTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ch === cn || ch.includes(cn) || cn.includes(ch)) {
      parts.push(`channel "${candidate.channelTitle}" matches creator constraint`);
    }
  }

  if (candidate.publishedAt) {
    const ageDays = Math.max(0, (Date.now() - new Date(candidate.publishedAt).getTime()) / 86_400_000);
    if (ageDays < 1) parts.push("published today");
    else if (ageDays < 7) parts.push(`published ${Math.round(ageDays)} day${ageDays >= 1.5 ? "s" : ""} ago`);
    else if (ageDays < 30) parts.push(`published ${Math.round(ageDays / 7)} week${ageDays >= 10.5 ? "s" : ""} ago`);
  }

  if (candidate.views != null && candidate.views > 0) {
    parts.push(`${formatViewCount(candidate.views)} views`);
  }

  parts.push(`relevance score ${(score * 100).toFixed(0)}%`);

  return parts.join(", ") + ".";
}

function formatViewCount(views: number): string {
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(0)}K`;
  return String(views);
}

type ExploreResult = ExploreYouTubeOutput["results"][number];

function buildExploreHints(
  results: ExploreResult[],
  background?: ExploreYouTubeOutput["backgroundEnrichment"],
): string[] {
  const hints: string[] = [];

  // Detect stats/benchmarks/comparisons in transcript summaries — trigger chart creation
  const allSummaries = results.map((r) => r.transcriptSummary ?? "").join(" ");
  if (hasChartableData(allSummaries)) {
    hints.push(
      "IMPORTANT: Transcript summaries contain benchmark scores, statistics, or comparison data. " +
      "Extract the key numbers and create visual comparison charts (bar charts, tables, or infographics) " +
      "as part of your response. Do NOT wait for the user to ask — present the data visually now.",
    );
  }

  // Specific hints from key moments
  for (const r of results.slice(0, 3)) {
    if (r.keyMoments && r.keyMoments.length > 0) {
      const moment = r.keyMoments.find((m) => m.label.length > 10) ?? r.keyMoments[0];
      hints.push(
        `"${r.video.title}" covers "${moment.label}" at ${formatTimestamp(moment.timestampSec)} — you can ask about this topic.`,
      );
    }
  }

  // Background enrichment hints
  if (background) {
    if (background.assetsBeingPrepared.includes("transcript_search")) {
      hints.push("Transcript search is being prepared in the background — use searchTranscripts for follow-up questions.");
    }
    if (background.assetsBeingPrepared.includes("visual_search")) {
      hints.push("Visual search is being prepared — use searchVisualContent to find specific frames, charts, or slides.");
    }
  }

  // Multi-result hints
  if (results.length > 1) {
    const channels = [...new Set(results.map((r) => r.video.channelTitle))];
    if (channels.length > 1) {
      hints.push(`Results span ${channels.length} creators — you can compare their perspectives.`);
    }
  }

  return hints;
}

/** Detect whether transcript text contains numbers, benchmarks, or comparison data worth charting. */
function hasChartableData(text: string): boolean {
  if (!text || text.length < 50) return false;
  const statsPattern = /\d+[,.]?\d*\s*(%|GB\/s|GB|MB|TB|GHz|MHz|fps|ms|hours?|minutes?|watts?|score|points)/i;
  const comparisonPattern = /\b(faster|slower|improvement|vs\.?|versus|compared|benchmark|score|performance|speed|battery|upgrade)\b/i;
  return statsPattern.test(text) && comparisonPattern.test(text);
}

function buildExploreLimitations(mode: string, depth: string, candidateCount: number): string[] {
  const limitations: string[] = [];
  if (candidateCount < 5) {
    limitations.push("Fewer than 5 candidates found — results may not fully represent available content.");
  }
  if (depth === "quick") {
    limitations.push("Quick depth: metadata only, no transcript analysis. Use 'standard' or 'deep' for richer results.");
  }
  if (mode === "explore") {
    limitations.push("Explore mode ranks by diversity and relevance — not every top result will be the absolute best match.");
  }
  return limitations;
}
