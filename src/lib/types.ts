export type SourceTier = "youtube_api" | "yt_dlp" | "page_extract" | "none";

export interface Provenance {
  sourceTier: SourceTier;
  sourceNotes?: string[];
  fetchedAt: string;
  fallbackDepth: 0 | 1 | 2 | 3;
  partial: boolean;
}

export interface Pagination {
  nextPageToken?: string;
  prevPageToken?: string;
}

export interface GracefulError {
  code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "UPSTREAM_UNAVAILABLE"
    | "INSUFFICIENT_PUBLIC_DATA"
    | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
  attemptedTiers: SourceTier[];
  suggestion?: string;
}

export interface TokenControls {
  compact?: boolean;
  includeRaw?: boolean;
  fields?: string[];
}

export interface ServiceOptions {
  dryRun?: boolean;
}

export interface SearchItem {
  videoId: string;
  title: string;
  channelId?: string;
  channelTitle: string;
  publishedAt?: string;
  durationSec?: number;
  views?: number;
  likes?: number;
  comments?: number;
  tags?: string[];
  description?: string;
  url: string;
}

export interface VideoRecord {
  videoId: string;
  title: string;
  channelId?: string;
  channelTitle: string;
  publishedAt?: string;
  durationSec?: number;
  views?: number;
  likes?: number;
  comments?: number;
  tags?: string[];
  language?: string;
  category?: string;
  description?: string;
  transcriptLanguages?: string[];
  transcriptAvailable?: boolean;
  chapters?: Chapter[];
  url: string;
}

export interface Chapter {
  title: string;
  tStartSec: number;
  tEndSec?: number;
}

export interface CommentRecord {
  commentId?: string;
  author: string;
  text: string;
  likeCount?: number;
  publishedAt?: string;
  replies?: CommentRecord[];
}

export interface ChannelRecord {
  channelId: string;
  title: string;
  handle?: string;
  createdAt?: string;
  country?: string;
  description?: string;
  descriptionSummary?: string;
  subscribers?: number;
  totalViews?: number;
  totalVideos?: number;
  uploadsPlaylistId?: string;
  url: string;
}

export interface TranscriptSegment {
  tStartSec: number;
  tEndSec?: number;
  text: string;
  topicLabel?: string;
  chapterTitle?: string;
}

export interface TranscriptRecord {
  videoId: string;
  languageUsed?: string;
  sourceType: "manual_caption" | "auto_caption" | "generated_from_audio" | "unknown";
  confidence?: number;
  transcriptText: string;
  segments: TranscriptSegment[];
  chapters?: Chapter[];
}

export interface FindVideosInput extends TokenControls {
  query: string;
  maxResults?: number;
  order?: "relevance" | "date" | "viewCount" | "rating";
  regionCode?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  channelId?: string;
  duration?: "any" | "short" | "medium" | "long";
}

export interface FindVideosOutput {
  query: string;
  results: Array<{
    videoId: string;
    title: string;
    channelId?: string;
    channelTitle: string;
    publishedAt?: string;
    durationSec?: number;
    views?: number;
    engagementRate?: number;
  }>;
  pagination?: Pagination;
  provenance: Provenance;
}

export interface InspectVideoInput extends TokenControls {
  videoIdOrUrl: string;
  includeTranscriptMeta?: boolean;
  includeEngagementRatios?: boolean;
}

export interface InspectVideoOutput {
  video: {
    videoId: string;
    title: string;
    channelId?: string;
    channelTitle: string;
    publishedAt?: string;
    durationSec?: number;
    category?: string;
    tags?: string[];
    language?: string;
  };
  stats: {
    views?: number;
    likes?: number;
    comments?: number;
    likeRate?: number;
    commentRate?: number;
    viewVelocity24h?: number;
  };
  transcriptMeta?: {
    available: boolean;
    languages?: string[];
  };
  provenance: Provenance;
}

export interface InspectChannelInput extends TokenControls {
  channelIdOrHandleOrUrl: string;
}

export interface InspectChannelOutput {
  channel: {
    channelId: string;
    title: string;
    handle?: string;
    createdAt?: string;
    country?: string;
    descriptionSummary?: string;
  };
  stats: {
    subscribers?: number;
    totalViews?: number;
    totalVideos?: number;
    avgViewsPerVideo?: number;
  };
  cadence: {
    uploadsLast30d?: number;
    uploadsLast90d?: number;
    medianDaysBetweenUploads?: number;
  };
  provenance: Provenance;
}

export interface ListChannelCatalogInput extends TokenControls {
  channelIdOrHandleOrUrl: string;
  maxResults?: number;
  sortBy?: "date_desc" | "date_asc" | "views_desc";
  includeShorts?: boolean;
  includeLongForm?: boolean;
  publishedWithinDays?: number;
}

export interface ListChannelCatalogOutput {
  channelId: string;
  items: Array<{
    videoId: string;
    title: string;
    publishedAt?: string;
    durationSec?: number;
    format: "short" | "long" | "unknown";
    views?: number;
    likes?: number;
    comments?: number;
  }>;
  pagination?: Pagination;
  provenance: Provenance;
}

export interface ReadTranscriptInput extends TokenControls {
  videoIdOrUrl: string;
  language?: string;
  mode?: "full" | "summary" | "key_moments" | "chapters";
  includeTimestamps?: boolean;
  chunkWindowSec?: number;
  offset?: number;
  limit?: number;
}

export interface ReadTranscriptOutput {
  videoId: string;
  languageUsed?: string;
  transcript: {
    mode: "full" | "summary" | "key_moments" | "chapters";
    text?: string;
    segments?: Array<{
      tStartSec: number;
      tEndSec?: number;
      text: string;
      topicLabel?: string;
      chapterTitle?: string;
    }>;
  };
  longVideoHandling?: {
    totalCharacters: number;
    totalEstimatedTokens: number;
    autoDowngraded: boolean;
    originalMode?: string;
    pagination?: {
      offset: number;
      limit: number;
      hasMore: boolean;
      nextOffset?: number;
    };
  };
  chapters?: Array<{
    title: string;
    tStartSec: number;
    tEndSec?: number;
  }>;
  quality: {
    sourceType: "manual_caption" | "auto_caption" | "generated_from_audio" | "unknown";
    confidence?: number;
  };
  provenance: Provenance;
}

export interface ReadCommentsInput extends TokenControls {
  videoIdOrUrl: string;
  maxTopLevel?: number;
  includeReplies?: boolean;
  maxRepliesPerThread?: number;
  order?: "relevance" | "time";
  languageHint?: string;
}

export interface ReadCommentsOutput {
  videoId: string;
  totalFetched: number;
  threads: Array<{
    commentId?: string;
    author: string;
    text: string;
    likeCount?: number;
    publishedAt?: string;
    replies?: Array<{
      commentId?: string;
      author: string;
      text: string;
      likeCount?: number;
      publishedAt?: string;
    }>;
  }>;
  pagination?: Pagination;
  provenance: Provenance;
}

export interface MeasureAudienceSentimentInput extends TokenControls {
  videoIdOrUrl: string;
  sampleSize?: number;
  includeThemes?: boolean;
  includeRepresentativeQuotes?: boolean;
}

export interface MeasureAudienceSentimentOutput {
  videoId: string;
  sampleSize: number;
  sentiment: {
    positivePct: number;
    neutralPct: number;
    negativePct: number;
    sentimentScore: number;
  };
  themes?: Array<{
    theme: string;
    prevalencePct: number;
    sentimentScore: number;
  }>;
  riskSignals?: Array<{
    signal: string;
    severity: "low" | "medium" | "high";
    frequencyPct: number;
  }>;
  representativeQuotes?: Array<{
    text: string;
    sentiment: "positive" | "neutral" | "negative";
  }>;
  provenance: Provenance;
}

export type VideoAnalysisMode =
  | "video_info"
  | "transcript"
  | "comments"
  | "sentiment"
  | "hook_patterns"
  | "tag_title_patterns";

export interface AnalyzeVideoSetInput extends TokenControls {
  videoIdsOrUrls: string[];
  analyses: VideoAnalysisMode[];
  commentsSampleSize?: number;
  transcriptMode?: "summary" | "key_moments" | "full";
}

export interface AnalyzeVideoSetItem {
  videoId: string;
  analyses: {
    videoInfo?: InspectVideoOutput;
    transcript?: ReadTranscriptOutput;
    comments?: ReadCommentsOutput;
    sentiment?: MeasureAudienceSentimentOutput;
    hookPatterns?: {
      hookScore: number;
      hookType: "question" | "promise" | "shock" | "story" | "proof" | "other";
      first30SecSummary: string;
    };
    tagTitlePatterns?: {
      recurringKeywords: string[];
      titleStructure: string[];
    };
  };
  errors?: GracefulError[];
  provenance: Provenance;
}

export interface AnalyzeVideoSetOutput {
  requestedCount: number;
  processedCount: number;
  failedCount: number;
  items: AnalyzeVideoSetItem[];
  summary: {
    successRatePct: number;
    avgFallbackDepth: number;
  };
}

export interface ExpandPlaylistInput extends TokenControls {
  playlistUrlOrId: string;
  maxVideos?: number;
  includeVideoMeta?: boolean;
}

export interface ExpandPlaylistOutput {
  playlist: {
    playlistId: string;
    title?: string;
    channelTitle?: string;
    videoCountReported?: number;
  };
  videos: Array<{
    videoId: string;
    title?: string;
    publishedAt?: string;
    channelTitle?: string;
  }>;
  truncated: boolean;
  provenance: Provenance;
}

export interface AnalyzePlaylistInput extends TokenControls {
  playlistUrlOrId: string;
  analyses: VideoAnalysisMode[];
  maxVideos?: number;
  commentsSampleSize?: number;
  transcriptMode?: "summary" | "key_moments" | "full";
}

export interface AnalyzePlaylistOutput {
  playlist: {
    playlistId: string;
    title?: string;
    channelTitle?: string;
  };
  run: {
    maxVideos: number;
    processed: number;
    failed: number;
  };
  items: AnalyzeVideoSetItem[];
  aggregate: {
    medianViews?: number;
    avgSentimentScore?: number;
    dominantThemes?: string[];
    hookBenchmark?: {
      medianHookScore?: number;
      topQuartileHookScore?: number;
    };
  };
  provenance: Provenance;
}

export interface PlaylistKnowledgeBaseInput extends TokenControls {
  playlistUrlOrId: string;
  collectionId?: string;
  maxVideos?: number;
  chunkStrategy?: "time_window" | "chapters" | "auto";
  chunkSizeSec?: number;
  chunkOverlapSec?: number;
  language?: string;
  reindexExisting?: boolean;
  label?: string;
  embeddingProvider?: "local" | "gemini";
  embeddingModel?: string;
  embeddingDimensions?: number;
  activateCollection?: boolean;
}

export interface VideoKnowledgeBaseInput extends TokenControls {
  videoIdsOrUrls: string[];
  chunkStrategy?: "time_window" | "chapters" | "auto";
  chunkSizeSec?: number;
  chunkOverlapSec?: number;
  language?: string;
  collectionId?: string;
  reindexExisting?: boolean;
  label?: string;
  embeddingProvider?: "local" | "gemini";
  embeddingModel?: string;
  embeddingDimensions?: number;
  activateCollection?: boolean;
}

export interface CollectionScopeMeta {
  mode: "explicit" | "active" | "all_collections";
  activeCollectionId?: string;
  searchedCollectionIds: string[];
}

export interface ImportPlaylistOutput {
  playlist: {
    playlistId: string;
    title?: string;
    channelTitle?: string;
    videoCountReported?: number;
  };
  import: {
    totalVideos: number;
    imported: number;
    skipped: number;
    failed: number;
    chunksCreated: number;
    embeddingsGenerated: number;
  };
  failures?: Array<{
    videoId: string;
    reason: string;
  }>;
  collectionId: string;
  activeCollectionId?: string;
  provenance: Provenance;
}

export interface ImportVideosOutput {
  import: {
    totalVideos: number;
    imported: number;
    skipped: number;
    failed: number;
    chunksCreated: number;
    embeddingsGenerated: number;
  };
  failures?: Array<{
    videoId: string;
    reason: string;
  }>;
  collectionId: string;
  activeCollectionId?: string;
  provenance: Provenance;
}

export interface SearchTranscriptsInput extends TokenControls {
  query: string;
  collectionId?: string;
  maxResults?: number;
  minScore?: number;
  videoIdFilter?: string[];
  useActiveCollection?: boolean;
}

export interface SearchTranscriptsOutput {
  query: string;
  results: Array<{
    collectionId: string;
    videoId: string;
    videoTitle: string;
    channelTitle?: string;
    chunkText: string;
    tStartSec: number;
    tEndSec?: number;
    timestampUrl: string;
    score: number;
    lexicalScore?: number;
    semanticScore?: number;
    context?: {
      prevChunkText?: string;
      nextChunkText?: string;
    };
  }>;
  searchMeta: {
    totalChunksSearched: number;
    embeddingModel: string;
    searchLatencyMs: number;
    scope: CollectionScopeMeta;
  };
  provenance: Provenance;
}

export interface CollectionSummary {
  collectionId: string;
  label?: string;
  sourceType: "playlist" | "videos";
  sourcePlaylistId?: string;
  sourceTitle?: string;
  sourceChannelTitle?: string;
  videoCount: number;
  totalChunks: number;
  createdAt: string;
  lastUpdatedAt: string;
  embeddingProvider?: "local" | "gemini";
  embeddingModel?: string;
  embeddingDimensions?: number;
  isActive?: boolean;
  videos?: Array<{
    videoId: string;
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
  }>;
}

export interface ListCollectionsInput extends TokenControls {
  includeVideoList?: boolean;
}

export interface ListCollectionsOutput {
  collections: CollectionSummary[];
  activeCollectionId?: string;
  provenance: Provenance;
}

export interface SetActiveCollectionInput {
  collectionId: string;
}

export interface SetActiveCollectionOutput {
  activeCollectionId: string;
  collection?: CollectionSummary;
  provenance: Provenance;
}

export interface ClearActiveCollectionOutput {
  cleared: boolean;
  previousActiveCollectionId?: string;
  provenance: Provenance;
}

export interface DiagnosticCheck {
  name: string;
  status: "ok" | "warn" | "error" | "skipped";
  detail: string;
}

export interface ClientDetectionSummary {
  clientId: "claude_desktop" | "claude_code" | "cursor" | "vscode" | "chatgpt_desktop" | "codex";
  name: string;
  detected: boolean;
  supportLevel: "supported" | "scaffolded" | "future";
  installSurface: "config_file" | "binary" | "app_bundle" | "mixed" | "unknown";
  configPath?: string;
  binary?: string;
  notes?: string[];
}

export interface CheckImportReadinessInput extends TokenControls {
  videoIdOrUrl: string;
  language?: string;
}

export interface CheckImportReadinessOutput {
  videoId: string;
  title?: string;
  importReadiness: {
    canImport: boolean;
    status: "ready" | "ready_sparse_transcript" | "blocked" | "uncertain";
    summary: string;
    suggestedCollectionId: string;
  };
  transcript: {
    available: boolean;
    sourceType?: "manual_caption" | "auto_caption" | "generated_from_audio" | "unknown";
    languageUsed?: string;
    segmentCount?: number;
    transcriptCharacters?: number;
    sparseTranscript?: boolean;
    estimatedSearchableChunks?: number;
  };
  checks: DiagnosticCheck[];
  suggestions: string[];
  provenance: Provenance;
}

export interface BuildVideoDossierInput extends TokenControls {
  videoIdOrUrl: string;
  commentSampleSize?: number;
  includeComments?: boolean;
  includeSentiment?: boolean;
  includeTranscriptSummary?: boolean;
}

export interface BuildVideoDossierOutput {
  video: InspectVideoOutput["video"];
  stats: InspectVideoOutput["stats"];
  transcript: {
    available: boolean;
    importReadiness: CheckImportReadinessOutput["importReadiness"];
    languageUsed?: string;
    sourceType?: "manual_caption" | "auto_caption" | "generated_from_audio" | "unknown";
    summary?: string;
    sparseTranscript?: boolean;
  };
  comments?: {
    totalFetched: number;
    sample: Array<{
      author: string;
      text: string;
      likeCount?: number;
      publishedAt?: string;
    }>;
  };
  audienceSentiment?: MeasureAudienceSentimentOutput["sentiment"];
  riskSignals?: MeasureAudienceSentimentOutput["riskSignals"];
  representativeQuotes?: MeasureAudienceSentimentOutput["representativeQuotes"];
  suggestedCollectionId: string;
  checks: DiagnosticCheck[];
  provenance: Provenance;
}

export interface CheckSystemHealthInput extends TokenControls {
  runLiveChecks?: boolean;
}

export interface CheckSystemHealthOutput {
  overallStatus: "ready" | "degraded" | "setup_needed";
  dataDir: string;
  runtime: {
    nodeVersion: string;
    packageName: string;
    packageVersion: string;
  };
  keys: {
    youtubeApiConfigured: boolean;
    geminiConfigured: boolean;
  };
  clients: ClientDetectionSummary[];
  checks: DiagnosticCheck[];
  suggestions: string[];
  provenance: Provenance;
}

// ── Comment Knowledge Base Types ──

export interface ImportCommentsInput extends TokenControls {
  videoIdOrUrl: string;
  collectionId?: string;
  maxTopLevel?: number;
  includeReplies?: boolean;
  maxRepliesPerThread?: number;
  order?: "relevance" | "time";
  label?: string;
  activateCollection?: boolean;
}

export interface ImportCommentsOutput {
  videoId: string;
  collectionId: string;
  import: {
    totalThreads: number;
    totalComments: number;
    chunksCreated: number;
  };
  activeCollectionId?: string;
  provenance: Provenance;
}

export interface SearchCommentsInput extends TokenControls {
  query: string;
  collectionId?: string;
  maxResults?: number;
  minScore?: number;
  videoIdFilter?: string[];
  useActiveCollection?: boolean;
}

export interface SearchCommentsOutput {
  query: string;
  results: Array<{
    collectionId: string;
    videoId: string;
    videoTitle: string;
    author: string;
    commentText: string;
    likeCount?: number;
    publishedAt?: string;
    isReply: boolean;
    parentAuthor?: string;
    score: number;
    lexicalScore?: number;
    semanticScore?: number;
  }>;
  searchMeta: {
    totalChunksSearched: number;
    embeddingModel: string;
    searchLatencyMs: number;
    scope: CollectionScopeMeta;
  };
  provenance: Provenance;
}

export interface ListCommentCollectionsInput extends TokenControls {
  includeVideoList?: boolean;
}

export interface CommentCollectionSummary {
  collectionId: string;
  label?: string;
  videoCount: number;
  totalCommentChunks: number;
  createdAt: string;
  lastUpdatedAt: string;
  isActive?: boolean;
  videos?: Array<{
    videoId: string;
    title?: string;
    threadCount?: number;
    commentCount?: number;
  }>;
}

export interface ListCommentCollectionsOutput {
  collections: CommentCollectionSummary[];
  activeCollectionId?: string;
  provenance: Provenance;
}

export interface RemoveCommentCollectionInput {
  collectionId: string;
}

export interface RemoveCommentCollectionOutput {
  removed: boolean;
  collectionId: string;
  chunksDeleted: number;
  videosDeleted: number;
  clearedActiveCollection?: boolean;
  provenance: Provenance;
}

export interface SetActiveCommentCollectionInput {
  collectionId: string;
}

export interface SetActiveCommentCollectionOutput {
  activeCollectionId: string;
  collection?: CommentCollectionSummary;
  provenance: Provenance;
}

export interface ClearActiveCommentCollectionOutput {
  cleared: boolean;
  previousActiveCollectionId?: string;
  provenance: Provenance;
}

export interface RemoveCollectionInput {
  collectionId: string;
}

export interface RemoveCollectionOutput {
  removed: boolean;
  collectionId: string;
  chunksDeleted: number;
  videosDeleted: number;
  clearedActiveCollection?: boolean;
  provenance: Provenance;
}

export interface ScoreHookPatternsInput extends TokenControls {
  videoIdsOrUrls: string[];
  hookWindowSec?: number;
}

export interface ScoreHookPatternsOutput {
  videos: Array<{
    videoId: string;
    hookScore: number;
    hookType: "question" | "promise" | "shock" | "story" | "proof" | "other";
    first30SecSummary: string;
    weakSignals: string[];
    improvements: string[];
  }>;
  benchmark: {
    medianHookScore: number;
    topQuartileHookScore: number;
  };
  provenance: Provenance;
}

export interface ResearchTagsAndTitlesInput extends TokenControls {
  seedTopic: string;
  regionCode?: string;
  language?: string;
  maxExamples?: number;
}

export interface ResearchTagsAndTitlesOutput {
  seedTopic: string;
  winningPatterns: {
    titleStructures: string[];
    recurringKeywords: string[];
    highSignalTags: string[];
    lowSignalTags: string[];
  };
  examples: Array<{
    videoId: string;
    title: string;
    tags?: string[];
    views?: number;
    engagementRate?: number;
  }>;
  provenance: Provenance;
}

export interface CompareShortsVsLongInput extends TokenControls {
  channelIdOrHandleOrUrl: string;
  lookbackDays?: number;
}

export interface CompareShortsVsLongOutput {
  channelId: string;
  shorts: {
    count: number;
    medianViews?: number;
    medianEngagementRate?: number;
    medianCommentRate?: number;
  };
  longForm: {
    count: number;
    medianViews?: number;
    medianEngagementRate?: number;
    medianCommentRate?: number;
  };
  recommendation: {
    suggestedMixShortPct: number;
    suggestedMixLongPct: number;
    rationale: string[];
  };
  provenance: Provenance;
}

export interface RecommendUploadWindowsInput extends TokenControls {
  channelIdOrHandleOrUrl: string;
  timezone: string;
  lookbackDays?: number;
}

export interface RecommendUploadWindowsOutput {
  channelId: string;
  recommendedSlots: Array<{
    weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
    hourLocal: number;
    confidence: number;
    rationale: string;
  }>;
  observedPatterns: {
    bestDay?: string;
    bestHour?: number;
    consistencyScore?: number;
  };
  provenance: Provenance;
}

// ─── Trends & Discovery ────────────────────────────────────────────

export interface DiscoverNicheTrendsInput extends TokenControls {
  niche: string;
  regionCode?: string;
  maxResults?: number;
  lookbackDays?: number;
}

export interface TrendingVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt?: string;
  durationSec?: number;
  views?: number;
  likes?: number;
  comments?: number;
  engagementRate?: number;
  viewVelocity24h?: number;
  format: "short" | "long" | "unknown";
  tags?: string[];
}

export interface NicheMomentum {
  medianViews?: number;
  medianEngagementRate?: number;
  recentVsOlderViewRatio?: number;
  recencyBias: "accelerating" | "steady" | "decelerating" | "insufficient_data";
  explanation: string;
}

export interface ContentGap {
  angle: string;
  evidence: string;
  opportunityScore: number;
}

export interface NicheSaturation {
  totalResultsSampled: number;
  medianViews?: number;
  topQuartileViews?: number;
  bottomQuartileViews?: number;
  saturationLevel: "low" | "medium" | "high" | "insufficient_data";
  explanation: string;
}

export interface DiscoverNicheTrendsOutput {
  niche: string;
  regionCode?: string;
  trendingVideos: TrendingVideo[];
  momentum: NicheMomentum;
  saturation: NicheSaturation;
  contentGaps: ContentGap[];
  recurringKeywords: string[];
  titlePatterns: string[];
  formatBreakdown: {
    shortsPct: number;
    longFormPct: number;
    unknownPct: number;
  };
  limitations: string[];
  provenance: Provenance;
}

export interface ExploreNicheCompetitorsInput extends TokenControls {
  niche: string;
  regionCode?: string;
  maxChannels?: number;
}

export interface NicheCompetitor {
  channelId?: string;
  channelTitle: string;
  videosSampled: number;
  medianViews?: number;
  medianEngagementRate?: number;
  estimatedUploadFrequency?: string;
  topVideo?: {
    videoId: string;
    title: string;
    views?: number;
  };
}

export interface ExploreNicheCompetitorsOutput {
  niche: string;
  competitors: NicheCompetitor[];
  landscape: {
    totalChannelsSampled: number;
    medianViewsAcrossChannels?: number;
    topPerformerChannelTitle?: string;
  };
  limitations: string[];
  provenance: Provenance;
}

/* ────────────────────────────────────────────────────────────────
 * Explore module
 * ──────────────────────────────────────────────────────────────── */

export interface ExploreYouTubeInput extends TokenControls {
  /** Single natural-language query — tool constructs 2-3 search variations. */
  query?: string;
  /** Pre-constructed search queries (1-5). Takes precedence over query. */
  searches?: string[];
  mode?: "specific" | "explore";
  /** Channel name or handle — hard constraint for ranking. */
  creator?: string;
  freshness?: "any" | "week" | "month" | "year";
  /** Free text describing the user's role — passed through for client framing. */
  persona?: string;
  maxResults?: number;
  depth?: "quick" | "standard" | "deep";
  selectionStrategy?: "best_match" | "diverse_set";
  prepareVisualSearch?: boolean;
  prepareTranscriptSearch?: boolean;
}

export interface ExploreYouTubeOutput {
  mode: "specific" | "explore";
  persona?: string;
  totalCandidatesEvaluated: number;
  results: Array<{
    rank: number;
    selectionReason: string;
    video: {
      videoId: string;
      title: string;
      channelTitle: string;
      publishedAt?: string;
      durationSec?: number;
      views?: number;
      likes?: number;
    };
    keyMoments?: Array<{
      timestampSec: number;
      label: string;
    }>;
    transcriptSearchReady: boolean;
    visualSearchReady: boolean;
  }>;
  followUpHints: string[];
  backgroundEnrichment?: {
    status: "preparing";
    videosQueued: string[];
    assetsBeingPrepared: string[];
  };
  limitations: string[];
  provenance: Provenance;
}

/* ────────────────────────────────────────────────────────────────
 * Media / Asset types (V-next: local media storage)
 * ──────────────────────────────────────────────────────────────── */

export type MediaAssetKind = "video" | "audio" | "thumbnail" | "keyframe";

export interface DownloadAssetInput {
  videoIdOrUrl: string;
  format: "best_video" | "best_audio" | "thumbnail" | "worst_video";
  maxSizeMb?: number;
}

export interface DownloadAssetOutput {
  asset: {
    assetId: string;
    videoId: string;
    kind: MediaAssetKind;
    filePath: string;
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    durationSec?: number;
    width?: number;
    height?: number;
  };
  downloadedBytes: number;
  durationMs: number;
  cached: boolean;
  provenance: Provenance;
}

export interface ListMediaAssetsInput {
  videoIdOrUrl?: string;
  kind?: MediaAssetKind;
  limit?: number;
}

export interface ListMediaAssetsOutput {
  assets: Array<{
    assetId: string;
    videoId: string;
    kind: MediaAssetKind;
    filePath: string;
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    timestampSec?: number;
    width?: number;
    height?: number;
    durationSec?: number;
    createdAt: string;
  }>;
  stats: {
    totalAssets: number;
    totalSizeBytes: number;
    videoCount: number;
    byKind: Partial<Record<MediaAssetKind, number>>;
  };
  provenance: Provenance;
}

export interface RemoveMediaAssetInput {
  assetId?: string;
  videoIdOrUrl?: string;
  deleteFiles?: boolean;
}

export interface RemoveMediaAssetOutput {
  removed: number;
  freedBytes: number;
  provenance: Provenance;
}

export interface ExtractKeyframesInput {
  videoIdOrUrl: string;
  intervalSec?: number;
  maxFrames?: number;
  imageFormat?: "jpg" | "png" | "webp";
  width?: number;
}

export interface ExtractKeyframesOutput {
  videoId: string;
  framesExtracted: number;
  assets: Array<{
    assetId: string;
    filePath: string;
    timestampSec: number;
    width?: number;
    height?: number;
    fileSizeBytes: number;
  }>;
  durationMs: number;
  provenance: Provenance;
}

export interface MediaStoreHealthOutput {
  dataDir: string;
  assetsDir: string;
  stats: {
    totalAssets: number;
    totalSizeBytes: number;
    videoCount: number;
    byKind: Partial<Record<MediaAssetKind, number>>;
  };
  ffmpegAvailable: boolean;
  ffmpegVersion?: string;
  ytdlpAvailable: boolean;
  ytdlpVersion?: string;
  provenance: Provenance;
}

export interface IndexVisualContentInput {
  videoIdOrUrl: string;
  intervalSec?: number;
  maxFrames?: number;
  imageFormat?: "jpg" | "png" | "webp";
  width?: number;
  autoDownload?: boolean;
  downloadFormat?: "best_video" | "worst_video";
  forceReindex?: boolean;
  includeGeminiDescriptions?: boolean;
  includeGeminiEmbeddings?: boolean;
}

export interface IndexVisualContentOutput {
  videoId: string;
  sourceVideo: {
    videoId: string;
    url: string;
    title?: string;
    localVideoPath?: string;
  };
  indexing: {
    framesExtracted: number;
    framesAnalyzed: number;
    framesIndexed: number;
    intervalSec: number;
    maxFrames: number;
    autoDownloaded: boolean;
    descriptionProvider: "none" | "gemini";
    descriptionModel?: string;
    embeddingProvider: "none" | "gemini";
    embeddingModel?: string;
    embeddingDimensions?: number;
  };
  evidence: Array<{
    frameAssetId?: string;
    framePath: string;
    timestampSec: number;
    timestampLabel: string;
    ocrText?: string;
    visualDescription?: string;
  }>;
  limitations: string[];
  provenance: Provenance;
}

export interface SearchVisualContentInput {
  query: string;
  videoIdOrUrl?: string;
  maxResults?: number;
  minScore?: number;
  autoIndexIfNeeded?: boolean;
  intervalSec?: number;
  maxFrames?: number;
  imageFormat?: "jpg" | "png" | "webp";
  width?: number;
  autoDownload?: boolean;
  downloadFormat?: "best_video" | "worst_video";
  includeGeminiDescriptions?: boolean;
  includeGeminiEmbeddings?: boolean;
}

export interface SearchVisualContentOutput {
  query: string;
  results: Array<{
    score: number;
    lexicalScore: number;
    semanticScore?: number;
    matchedOn: Array<"ocr" | "description" | "semantic">;
    videoId: string;
    sourceVideoUrl: string;
    sourceVideoTitle?: string;
    frameAssetId?: string;
    framePath: string;
    timestampSec: number;
    timestampLabel: string;
    explanation: string;
    ocrText?: string;
    visualDescription?: string;
  }>;
  searchMeta: {
    searchedFrames: number;
    searchedVideos: number;
    descriptionProvider: "none" | "gemini" | "mixed";
    embeddingProvider: "none" | "gemini" | "mixed";
    embeddingModel?: string;
    queryMode: "ocr_description_lexical" | "gemini_semantic_plus_lexical";
  };
  coveredTimeRange?: { startSec: number; endSec: number };
  needsExpansion?: boolean;
  limitations: string[];
  provenance: Provenance;
}

export interface FindSimilarFramesInput {
  assetId?: string;
  framePath?: string;
  videoIdOrUrl?: string;
  maxResults?: number;
  minSimilarity?: number;
}

export interface FindSimilarFramesOutput {
  reference: {
    assetId?: string;
    framePath: string;
    videoId?: string;
  };
  results: Array<{
    similarity: number;
    videoId: string;
    sourceVideoUrl: string;
    sourceVideoTitle?: string;
    frameAssetId?: string;
    framePath: string;
    timestampSec: number;
    timestampLabel: string;
    explanation: string;
    ocrText?: string;
    visualDescription?: string;
  }>;
  searchMeta: {
    searchedFrames: number;
    similarityEngine: "apple_vision_feature_print";
  };
  limitations: string[];
  provenance: Provenance;
}
