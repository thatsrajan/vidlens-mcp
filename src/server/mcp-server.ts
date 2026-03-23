import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { YouTubeService } from "../lib/youtube-service.js";
import { findYtDlpBinary, managedBinaryPath, downloadYtDlp } from "../lib/ytdlp-installer.js";
import { resolveDefaultDataDir } from "../lib/install-diagnostics.js";
import { homedir } from "node:os";
import { MediaStore } from "../lib/media-store.js";
import { MediaDownloader } from "../lib/media-downloader.js";
import { ThumbnailExtractor } from "../lib/thumbnail-extractor.js";
import { parseVideoId } from "../lib/id-parsing.js";
import { generateVisualReport, openInBrowser, type VisualReportFrame } from "../lib/visual-report.js";

export const tools: Tool[] = [
  {
    name: "findVideos",
    description: "Search YouTube videos by intent. Returns compact ranked results with provenance and engagement hints.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "number", minimum: 1, maximum: 25 },
        order: { type: "string", enum: ["relevance", "date", "viewCount", "rating"] },
        regionCode: { type: "string" },
        publishedAfter: { type: "string" },
        publishedBefore: { type: "string" },
        channelId: { type: "string" },
        duration: { type: "string", enum: ["any", "short", "medium", "long"] },
        dryRun: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "inspectVideo",
    description: "Inspect a single video with compact metadata, normalized ratios, and transcript availability.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string" },
        includeTranscriptMeta: { type: "boolean" },
        includeEngagementRatios: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "inspectChannel",
    description: "Inspect a channel with summary stats and posting cadence heuristics.",
    inputSchema: {
      type: "object",
      properties: {
        channelIdOrHandleOrUrl: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["channelIdOrHandleOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "listChannelCatalog",
    description: "List a channel's recent catalog in compact creator-analysis shape.",
    inputSchema: {
      type: "object",
      properties: {
        channelIdOrHandleOrUrl: { type: "string" },
        maxResults: { type: "number", minimum: 1, maximum: 100 },
        sortBy: { type: "string", enum: ["date_desc", "date_asc", "views_desc"] },
        includeShorts: { type: "boolean" },
        includeLongForm: { type: "boolean" },
        publishedWithinDays: { type: "number", minimum: 1, maximum: 3650 },
        dryRun: { type: "boolean" },
      },
      required: ["channelIdOrHandleOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "readTranscript",
    description: "Read transcript in summary, key moments, chapters, or paginated full mode with long-video safeguards.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string" },
        language: { type: "string" },
        mode: { type: "string", enum: ["full", "summary", "key_moments", "chapters"] },
        includeTimestamps: { type: "boolean" },
        chunkWindowSec: { type: "number", minimum: 30, maximum: 900 },
        offset: { type: "number", minimum: 0 },
        limit: { type: "number", minimum: 1000, maximum: 64000 },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "readComments",
    description: "Read top-level comments with optional replies and structured provenance.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string" },
        maxTopLevel: { type: "number", minimum: 1, maximum: 200 },
        includeReplies: { type: "boolean" },
        maxRepliesPerThread: { type: "number", minimum: 0, maximum: 20 },
        order: { type: "string", enum: ["relevance", "time"] },
        languageHint: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "measureAudienceSentiment",
    description: "Heuristic audience sentiment analysis from comments with themes, risk signals, and quote samples.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string" },
        sampleSize: { type: "number", minimum: 1, maximum: 200 },
        includeThemes: { type: "boolean" },
        includeRepresentativeQuotes: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "analyzeVideoSet",
    description: "Run multiple analyses across a video set with partial success, item-level errors, and provenance.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdsOrUrls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        analyses: {
          type: "array",
          items: { type: "string", enum: ["video_info", "transcript", "comments", "sentiment", "hook_patterns", "tag_title_patterns"] },
          minItems: 1,
        },
        commentsSampleSize: { type: "number", minimum: 1, maximum: 200 },
        transcriptMode: { type: "string", enum: ["summary", "key_moments", "full"] },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdsOrUrls", "analyses"],
      additionalProperties: false,
    },
  },
  {
    name: "expandPlaylist",
    description: "Expand a playlist into individual videos for downstream analysis and batch workflows.",
    inputSchema: {
      type: "object",
      properties: {
        playlistUrlOrId: { type: "string" },
        maxVideos: { type: "number", minimum: 1, maximum: 200 },
        includeVideoMeta: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["playlistUrlOrId"],
      additionalProperties: false,
    },
  },
  {
    name: "analyzePlaylist",
    description: "Expand and analyze a playlist in one call with partial success and aggregate benchmarks.",
    inputSchema: {
      type: "object",
      properties: {
        playlistUrlOrId: { type: "string" },
        analyses: {
          type: "array",
          items: { type: "string", enum: ["video_info", "transcript", "comments", "sentiment", "hook_patterns", "tag_title_patterns"] },
          minItems: 1,
        },
        maxVideos: { type: "number", minimum: 1, maximum: 100 },
        commentsSampleSize: { type: "number", minimum: 1, maximum: 200 },
        transcriptMode: { type: "string", enum: ["summary", "key_moments", "full"] },
        dryRun: { type: "boolean" },
      },
      required: ["playlistUrlOrId", "analyses"],
      additionalProperties: false,
    },
  },
  {
    name: "importPlaylist",
    description: "Import a playlist into the local transcript knowledge base for semantic search in Claude Desktop.",
    inputSchema: {
      type: "object",
      properties: {
        playlistUrlOrId: { type: "string" },
        collectionId: { type: "string" },
        maxVideos: { type: "number", minimum: 1, maximum: 200 },
        chunkStrategy: { type: "string", enum: ["time_window", "chapters", "auto"] },
        chunkSizeSec: { type: "number", minimum: 30, maximum: 900 },
        chunkOverlapSec: { type: "number", minimum: 0, maximum: 300 },
        language: { type: "string" },
        reindexExisting: { type: "boolean" },
        label: { type: "string" },
        embeddingProvider: { type: "string", enum: ["local", "gemini"] },
        embeddingModel: { type: "string" },
        embeddingDimensions: { type: "number", minimum: 128, maximum: 3072 },
        activateCollection: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["playlistUrlOrId"],
      additionalProperties: false,
    },
  },
  {
    name: "importVideos",
    description: "Import one or more videos into a local transcript collection for later semantic search.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdsOrUrls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
        collectionId: { type: "string" },
        chunkStrategy: { type: "string", enum: ["time_window", "chapters", "auto"] },
        chunkSizeSec: { type: "number", minimum: 30, maximum: 900 },
        chunkOverlapSec: { type: "number", minimum: 0, maximum: 300 },
        language: { type: "string" },
        reindexExisting: { type: "boolean" },
        label: { type: "string" },
        embeddingProvider: { type: "string", enum: ["local", "gemini"] },
        embeddingModel: { type: "string" },
        embeddingDimensions: { type: "number", minimum: 128, maximum: 3072 },
        activateCollection: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdsOrUrls"],
      additionalProperties: false,
    },
  },
  {
    name: "searchTranscripts",
    description: "Search imported transcript-text collections with active-collection focus by default and return ranked timestamped chunks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        collectionId: { type: "string" },
        maxResults: { type: "number", minimum: 1, maximum: 50 },
        minScore: { type: "number", minimum: 0, maximum: 1 },
        videoIdFilter: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        useActiveCollection: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "listCollections",
    description: "List local transcript collections, active search focus, and indexed video/chunk counts.",
    inputSchema: {
      type: "object",
      properties: {
        includeVideoList: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "setActiveCollection",
    description: "Set the default collection that transcript search should focus on when collectionId is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: { type: "string" },
      },
      required: ["collectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "clearActiveCollection",
    description: "Clear the active collection so transcript search fans back out across all collections.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "checkImportReadiness",
    description: "Diagnose whether a video is importable, including transcript availability, sparse-transcript warnings, and yt-dlp/API issues.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string" },
        language: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "buildVideoDossier",
    description: "Build a one-shot video dossier with core metadata/transcript readiness, optionally extended with comments, sentiment, and provenance.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string" },
        commentSampleSize: { type: "number", minimum: 1, maximum: 50 },
        includeComments: { type: "boolean" },
        includeSentiment: { type: "boolean" },
        includeTranscriptSummary: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "checkSystemHealth",
    description: "Check setup and provider health: yt-dlp, YouTube API, Gemini embeddings, and local storage.",
    inputSchema: {
      type: "object",
      properties: {
        runLiveChecks: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "removeCollection",
    description: "Delete a local transcript collection and its search index.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: { type: "string" },
      },
      required: ["collectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "scoreHookPatterns",
    description: "Heuristically score first-30-second hooks across one or more videos.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdsOrUrls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        hookWindowSec: { type: "number", minimum: 10, maximum: 120 },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdsOrUrls"],
      additionalProperties: false,
    },
  },
  {
    name: "researchTagsAndTitles",
    description: "Research title structures, keywords, and tag patterns around a seed topic.",
    inputSchema: {
      type: "object",
      properties: {
        seedTopic: { type: "string" },
        regionCode: { type: "string" },
        language: { type: "string" },
        maxExamples: { type: "number", minimum: 3, maximum: 20 },
        dryRun: { type: "boolean" },
      },
      required: ["seedTopic"],
      additionalProperties: false,
    },
  },
  {
    name: "compareShortsVsLong",
    description: "Compare recent Shorts vs long-form performance for a channel and suggest a format mix.",
    inputSchema: {
      type: "object",
      properties: {
        channelIdOrHandleOrUrl: { type: "string" },
        lookbackDays: { type: "number", minimum: 1, maximum: 3650 },
        dryRun: { type: "boolean" },
      },
      required: ["channelIdOrHandleOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "recommendUploadWindows",
    description: "Recommend upload windows from recent publishing history for a given timezone.",
    inputSchema: {
      type: "object",
      properties: {
        channelIdOrHandleOrUrl: { type: "string" },
        timezone: { type: "string", description: "IANA timezone, e.g. Australia/Sydney" },
        lookbackDays: { type: "number", minimum: 1, maximum: 3650 },
        dryRun: { type: "boolean" },
      },
      required: ["channelIdOrHandleOrUrl", "timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "discoverNicheTrends",
    description:
      "Discover what's trending in a niche right now. Returns top-performing and recent videos, momentum signals (accelerating/steady/decelerating), saturation analysis, content gap opportunities, keyword patterns, and format breakdown. Grounded in YouTube search data with honest limitations disclosed.",
    inputSchema: {
      type: "object",
      properties: {
        niche: {
          type: "string",
          description: "The niche or topic to explore, e.g. 'AI coding tools', 'home espresso', 'Kubernetes tutorials'",
        },
        regionCode: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. US, AU, DE" },
        maxResults: { type: "number", minimum: 5, maximum: 25 },
        lookbackDays: { type: "number", minimum: 7, maximum: 365 },
        dryRun: { type: "boolean" },
      },
      required: ["niche"],
      additionalProperties: false,
    },
  },
  {
    name: "exploreNicheCompetitors",
    description:
      "Discover active channels in a niche by analyzing who ranks in YouTube search results. Returns channel-level stats, top videos, and a landscape summary. Useful for competitive reconnaissance before entering a niche.",
    inputSchema: {
      type: "object",
      properties: {
        niche: {
          type: "string",
          description: "The niche or topic to explore, e.g. 'home lab networking', 'meal prep for beginners'",
        },
        regionCode: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
        maxChannels: { type: "number", minimum: 3, maximum: 20 },
        dryRun: { type: "boolean" },
      },
      required: ["niche"],
      additionalProperties: false,
    },
  },
  // ── Media / Asset tools ──────────────────────────────────────
  {
    name: "downloadAsset",
    description: "Download a YouTube video, audio track, or thumbnail to local storage. Returns asset manifest entry with file path. Does NOT perform visual indexing — this is honest file storage.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string", description: "YouTube video ID or URL" },
        format: {
          type: "string",
          enum: ["best_video", "best_audio", "thumbnail", "worst_video"],
          description: "What to download. best_video = highest quality video+audio, best_audio = audio only, thumbnail = YouTube thumbnail image, worst_video = smallest video for previews",
        },
        maxSizeMb: { type: "number", minimum: 1, maximum: 5000, description: "Max download size in MB (default 500)" },
      },
      required: ["videoIdOrUrl", "format"],
      additionalProperties: false,
    },
  },
  {
    name: "listMediaAssets",
    description: "List locally stored media assets. Filter by video or kind. Shows file paths, sizes, and manifest metadata.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string", description: "Filter to assets for this video" },
        kind: { type: "string", enum: ["video", "audio", "thumbnail", "keyframe"], description: "Filter by asset kind" },
        limit: { type: "number", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "removeMediaAsset",
    description: "Remove stored media assets. Specify assetId to remove one, or videoIdOrUrl to remove all assets for a video.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "Specific asset ID to remove" },
        videoIdOrUrl: { type: "string", description: "Remove all assets for this video" },
        deleteFiles: { type: "boolean", description: "Also delete files from disk (default true)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "extractKeyframes",
    description: "Extract keyframe images from a locally downloaded video at regular intervals using ffmpeg. Requires the video to be downloaded first via downloadAsset. Does NOT do visual search or classification — produces raw frame images.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string", description: "Video ID or URL (must have a local video asset)" },
        intervalSec: { type: "number", minimum: 1, maximum: 3600, description: "Extract one frame every N seconds (default 30)" },
        maxFrames: { type: "number", minimum: 1, maximum: 100, description: "Maximum frames to extract (default 20)" },
        imageFormat: { type: "string", enum: ["jpg", "png", "webp"], description: "Output image format (default jpg)" },
        width: { type: "number", minimum: 160, maximum: 3840, description: "Image width in pixels, height auto-scaled (default 640)" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaStoreHealth",
    description: "Check health of the local media store: disk usage, asset counts, ffmpeg/yt-dlp availability.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  // ── Visual Search tools ──────────────────────────────────
  {
    name: "indexVisualContent",
    description: "Build a real visual index for a video using extracted frames, Apple Vision OCR, Apple Vision feature prints, and optional Gemini frame descriptions. Returns frame evidence with local image paths.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string", description: "Video ID or URL to index visually" },
        intervalSec: { type: "number", minimum: 2, maximum: 3600, description: "Frame sampling interval in seconds (default 20)" },
        maxFrames: { type: "number", minimum: 1, maximum: 100, description: "Maximum frames to analyze (default 12)" },
        imageFormat: { type: "string", enum: ["jpg", "png", "webp"] },
        width: { type: "number", minimum: 160, maximum: 3840 },
        autoDownload: { type: "boolean", description: "Automatically download a small local video copy if none exists (default true)" },
        downloadFormat: { type: "string", enum: ["best_video", "worst_video"], description: "Video format used if auto-download is needed (default worst_video)" },
        forceReindex: { type: "boolean", description: "Re-run OCR/description analysis even if frames are already indexed" },
        includeGeminiDescriptions: { type: "boolean", description: "Use Gemini to describe each frame when a Gemini key is configured" },
        includeGeminiEmbeddings: { type: "boolean", description: "Generate Gemini embeddings over OCR/description text for semantic retrieval (default true when Gemini key is available)" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "searchVisualContent",
    description: "Search the actual visual content of a video or your indexed frame library. Uses Apple Vision OCR, optional Gemini frame descriptions, and optional Gemini semantic embeddings. Always returns frame/image evidence with timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Visual search query, e.g. 'whiteboard diagram' or 'slide that says title research checklist'" },
        videoIdOrUrl: { type: "string", description: "Optional video scope. If provided, the server can auto-index this video if needed." },
        maxResults: { type: "number", minimum: 1, maximum: 20 },
        minScore: { type: "number", minimum: 0, maximum: 1 },
        autoIndexIfNeeded: { type: "boolean", description: "If scoped to a video and no visual index exists yet, build it automatically (default true)" },
        intervalSec: { type: "number", minimum: 2, maximum: 3600, description: "Frame interval to use if auto-indexing is triggered" },
        maxFrames: { type: "number", minimum: 1, maximum: 100, description: "Frame cap to use if auto-indexing is triggered" },
        imageFormat: { type: "string", enum: ["jpg", "png", "webp"] },
        width: { type: "number", minimum: 160, maximum: 3840 },
        autoDownload: { type: "boolean" },
        downloadFormat: { type: "string", enum: ["best_video", "worst_video"] },
        includeGeminiDescriptions: { type: "boolean" },
        includeGeminiEmbeddings: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "findSimilarFrames",
    description: "Find frames that visually look like a reference frame using Apple Vision image feature prints. Accepts a frame assetId or a direct framePath and returns image-backed matches.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "Reference keyframe asset ID" },
        framePath: { type: "string", description: "Reference image path on disk" },
        videoIdOrUrl: { type: "string", description: "Optional video scope for similarity search" },
        maxResults: { type: "number", minimum: 1, maximum: 20 },
        minSimilarity: { type: "number", minimum: 0, maximum: 1 },
        dryRun: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  // ── Comment Knowledge Base Tools ──
  {
    name: "importComments",
    description: "Import a video's comments into the local comment knowledge base for semantic search. Fetches comments via the existing comment pipeline and indexes them for searchComments.",
    inputSchema: {
      type: "object",
      properties: {
        videoIdOrUrl: { type: "string", description: "YouTube video URL or ID" },
        collectionId: { type: "string", description: "Custom collection ID (default: comments-{videoId})" },
        maxTopLevel: { type: "number", minimum: 1, maximum: 200, description: "Max top-level comments to fetch" },
        includeReplies: { type: "boolean", description: "Include reply threads (default: true)" },
        maxRepliesPerThread: { type: "number", minimum: 0, maximum: 20 },
        order: { type: "string", enum: ["relevance", "time"] },
        label: { type: "string", description: "Human-readable collection label" },
        activateCollection: { type: "boolean", description: "Set as active comment collection (default: true)" },
        dryRun: { type: "boolean" },
      },
      required: ["videoIdOrUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "searchComments",
    description: "Search imported comment collections with ranked results. Returns matching comments with author, like count, and relevance score. Uses active comment collection by default.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        collectionId: { type: "string", description: "Specific collection to search" },
        maxResults: { type: "number", minimum: 1, maximum: 50 },
        minScore: { type: "number", minimum: 0, maximum: 1 },
        videoIdFilter: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        useActiveCollection: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "listCommentCollections",
    description: "List local comment collections, active search focus, and indexed comment counts.",
    inputSchema: {
      type: "object",
      properties: {
        includeVideoList: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "setActiveCommentCollection",
    description: "Set the default comment collection that searchComments should focus on when collectionId is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: { type: "string" },
      },
      required: ["collectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "clearActiveCommentCollection",
    description: "Clear the active comment collection so comment search fans back out across all comment collections.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "removeCommentCollection",
    description: "Delete a local comment collection and its search index.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: { type: "string" },
      },
      required: ["collectionId"],
      additionalProperties: false,
    },
  },
  // ── Explore module ──────────────────────────────────────────────
  {
    name: "exploreYouTube",
    description: "ALWAYS use this tool FIRST when the user wants to find, discover, or explore YouTube videos. Do NOT use web search for YouTube video discovery — use this tool instead. Searches YouTube directly with intelligent multi-query ranking and parallel enrichment. Returns ranked videos with transcript summaries, key moments, and readiness for follow-up. IMPORTANT: When results contain benchmark scores, statistics, or comparisons, ALWAYS create visual charts and infographics (bar charts, comparison tables) from the data immediately — do not wait for the user to ask. Use 'specific' mode to find one best video. Use 'explore' for topic discovery across creators. Depth: 'quick' for metadata, 'standard' for key moments + transcript summaries, 'deep' for background indexing.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query. Tool constructs 2-3 search variations. Provide this OR 'searches'." },
        searches: { type: "array", items: { type: "string" }, description: "1-5 pre-constructed search queries. Takes precedence over 'query'. Use for precise multi-angle searches." },
        mode: { type: "string", enum: ["specific", "explore"], description: "specific = find one best video, explore = discover multiple. Auto-detected from maxResults if omitted." },
        creator: { type: "string", description: "Channel name or handle — hard constraint for ranking (e.g. 'MKBHD', '@mkbhd')" },
        freshness: { type: "string", enum: ["any", "week", "month", "year"], description: "Time window for results. Default: any." },
        persona: { type: "string", description: "User's role or context (e.g. 'builder', 'marketer', 'PM'). Passed through for response framing." },
        maxResults: { type: "number", minimum: 1, maximum: 15, description: "Default: 1 for specific, 8 for explore" },
        depth: { type: "string", enum: ["quick", "standard", "deep"], description: "quick = metadata only, standard = + key moments, deep = + background transcript/visual indexing. Default: standard." },
        selectionStrategy: { type: "string", enum: ["best_match", "diverse_set"], description: "best_match = top scores, diverse_set = spread across creators. Default: best_match for specific, diverse_set for explore." },
        prepareVisualSearch: { type: "boolean", description: "Fire background visual indexing for the top result. Default: false." },
        prepareTranscriptSearch: { type: "boolean", description: "Fire background transcript import for selected videos. Default: true for deep, false otherwise." },
        dryRun: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
];

export function createYouTubeMcpServer(service = new YouTubeService()): Server {
  let mediaStore: MediaStore | undefined;
  let mediaDownloader: MediaDownloader | undefined;
  let thumbnailExtractor: ThumbnailExtractor | undefined;

  const getMediaStore = (): MediaStore => mediaStore ??= new MediaStore();
  const getMediaDownloader = (): MediaDownloader =>
    mediaDownloader ??= new MediaDownloader(getMediaStore());
  const getThumbnailExtractor = (): ThumbnailExtractor =>
    thumbnailExtractor ??= new ThumbnailExtractor(getMediaStore());

  const server = new Server(
    {
      name: "vidlens-mcp",
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
    const args = parseArgs(request.params.arguments);
    const dryRun = readBoolean(args, "dryRun", false);

    try {
      const toolName = request.params.name;
      const result = await executeTool(
        service, toolName, args, dryRun,
        getMediaStore, getMediaDownloader, getThumbnailExtractor,
      );

      // Visual search: auto-generate HTML gallery, strip framePaths from JSON
      if (toolName === "searchVisualContent" || toolName === "findSimilarFrames") {
        const resultObj = result as Record<string, unknown> | null;
        const matches = ((resultObj?.results ?? resultObj?.matches ?? []) as Array<Record<string, unknown>>);

        if (matches.length > 0) {
          const query = (resultObj?.query ?? "visual search") as string;

          // Strip framePaths so Claude can't try to read files directly
          const cleanedMatches = matches.map(({ framePath, ...rest }) => rest);
          const cleanedResult = { ...resultObj, results: cleanedMatches };

          // Build HTML gallery and open in browser
          const frames: VisualReportFrame[] = matches.slice(0, 10).map((m) => ({
            framePath: (m.framePath ?? "") as string,
            videoId: (m.videoId ?? "") as string,
            videoTitle: (m.sourceVideoTitle ?? m.videoTitle ?? "") as string,
            timestampSec: (m.timestampSec ?? m.tStartSec ?? 0) as number,
            timestampLabel: (m.timestampLabel ?? "") as string,
            ocrText: (m.ocrText ?? "") as string,
            description: (m.visualDescription ?? m.description ?? m.explanation ?? "") as string,
            score: (m.score ?? m.similarity) as number | undefined,
            matchedOn: (m.matchedOn ?? []) as string[],
            sourceVideoUrl: (m.sourceVideoUrl ?? "") as string,
          }));

          const report = generateVisualReport({
            query,
            frames,
            reportType: "search",
            searchMeta: {
              searchedFrames: resultObj?.searchedFrames as number | undefined,
              searchedVideos: resultObj?.searchedVideos as number | undefined,
              queryMode: resultObj?.queryMode as string | undefined,
            },
          });

          await openInBrowser(report.filePath);

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(cleanedResult, null, 2) },
              { type: "text" as const, text: `\n\nA visual gallery with ${frames.length} frame images has been opened in the user's browser at: ${report.filePath}\nPresent the text results above to the user. The images are already visible in their browser — do NOT try to copy, read, or display frame files.` },
            ],
          };
        }
      }

      // Index visual: strip framePaths, show summary only
      if (toolName === "indexVisualContent") {
        const resultObj = result as Record<string, unknown> | null;
        const evidence = ((resultObj?.evidence ?? []) as Array<Record<string, unknown>>);
        if (evidence.length > 0) {
          const cleanedEvidence = evidence.map(({ framePath, ...rest }) => rest);
          const cleanedResult = { ...resultObj, evidence: cleanedEvidence };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(cleanedResult, null, 2) },
              { type: "text" as const, text: `\n\n${evidence.length} frames indexed. Do NOT try to read or copy frame files from disk.` },
            ],
          };
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const payload = normalizeError(error);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  });

  return server;
}

export async function startStdioServer(service?: YouTubeService): Promise<void> {
  if (!service) {
    const dataDir = process.env.VIDLENS_DATA_DIR || resolveDefaultDataDir(homedir(), process.platform);
    const resolved = findYtDlpBinary(dataDir, process.platform, process.arch, process.env);
    let ytDlpBinary = resolved?.path;

    if (!resolved) {
      // Point at the managed path now — the binary will appear there once the download finishes.
      ytDlpBinary = managedBinaryPath(dataDir, process.platform);
      // Download in the background so the server starts instantly.
      // Tool calls that arrive before the download finishes gracefully fall back
      // to other tiers or fail with a retry hint. Subsequent calls just work.
      downloadYtDlp(dataDir, process.platform, process.arch)
        .then((p) => process.stderr.write(`[vidlens-mcp] yt-dlp ready: ${p}\n`))
        .catch((err) => process.stderr.write(
          `[vidlens-mcp] yt-dlp auto-download failed: ${err instanceof Error ? err.message : String(err)}. Run "npx vidlens-mcp setup" to retry.\n`,
        ));
    }

    service = new YouTubeService({ ytDlpBinary, dataDir });
  }
  const server = createYouTubeMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function executeTool(
  service: YouTubeService,
  toolName: string,
  args: Record<string, unknown>,
  dryRun: boolean,
  getMediaStore: () => MediaStore,
  getMediaDownloader: () => MediaDownloader,
  getThumbnailExtractor: () => ThumbnailExtractor,
): Promise<unknown> {
  switch (toolName) {
    case "findVideos":
      return service.findVideos(
        {
          query: readString(args, "query"),
          maxResults: optionalNumber(args, "maxResults"),
          order: optionalEnum(args, "order", ["relevance", "date", "viewCount", "rating"]),
          regionCode: optionalString(args, "regionCode"),
          publishedAfter: optionalString(args, "publishedAfter"),
          publishedBefore: optionalString(args, "publishedBefore"),
          channelId: optionalString(args, "channelId"),
          duration: optionalEnum(args, "duration", ["any", "short", "medium", "long"]),
        },
        { dryRun },
      );

    case "inspectVideo":
      return service.inspectVideo(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          includeTranscriptMeta: optionalBoolean(args, "includeTranscriptMeta"),
          includeEngagementRatios: optionalBoolean(args, "includeEngagementRatios"),
        },
        { dryRun },
      );

    case "inspectChannel":
      return service.inspectChannel(
        {
          channelIdOrHandleOrUrl: readString(args, "channelIdOrHandleOrUrl"),
        },
        { dryRun },
      );

    case "listChannelCatalog":
      return service.listChannelCatalog(
        {
          channelIdOrHandleOrUrl: readString(args, "channelIdOrHandleOrUrl"),
          maxResults: optionalNumber(args, "maxResults"),
          sortBy: optionalEnum(args, "sortBy", ["date_desc", "date_asc", "views_desc"]),
          includeShorts: optionalBoolean(args, "includeShorts"),
          includeLongForm: optionalBoolean(args, "includeLongForm"),
          publishedWithinDays: optionalNumber(args, "publishedWithinDays"),
        },
        { dryRun },
      );

    case "readTranscript":
      return service.readTranscript(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          language: optionalString(args, "language"),
          mode: optionalEnum(args, "mode", ["full", "summary", "key_moments", "chapters"]),
          includeTimestamps: optionalBoolean(args, "includeTimestamps"),
          chunkWindowSec: optionalNumber(args, "chunkWindowSec"),
          offset: optionalNumber(args, "offset"),
          limit: optionalNumber(args, "limit"),
        },
        { dryRun },
      );

    case "readComments":
      return service.readComments(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          maxTopLevel: optionalNumber(args, "maxTopLevel"),
          includeReplies: optionalBoolean(args, "includeReplies"),
          maxRepliesPerThread: optionalNumber(args, "maxRepliesPerThread"),
          order: optionalEnum(args, "order", ["relevance", "time"]),
          languageHint: optionalString(args, "languageHint"),
        },
        { dryRun },
      );

    case "measureAudienceSentiment":
      return service.measureAudienceSentiment(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          sampleSize: optionalNumber(args, "sampleSize"),
          includeThemes: optionalBoolean(args, "includeThemes"),
          includeRepresentativeQuotes: optionalBoolean(args, "includeRepresentativeQuotes"),
        },
        { dryRun },
      );

    case "analyzeVideoSet":
      return service.analyzeVideoSet(
        {
          videoIdsOrUrls: readStringArray(args, "videoIdsOrUrls"),
          analyses: readStringArray(args, "analyses") as Array<
            "video_info" | "transcript" | "comments" | "sentiment" | "hook_patterns" | "tag_title_patterns"
          >,
          commentsSampleSize: optionalNumber(args, "commentsSampleSize"),
          transcriptMode: optionalEnum(args, "transcriptMode", ["summary", "key_moments", "full"]),
        },
        { dryRun },
      );

    case "expandPlaylist":
      return service.expandPlaylist(
        {
          playlistUrlOrId: readString(args, "playlistUrlOrId"),
          maxVideos: optionalNumber(args, "maxVideos"),
          includeVideoMeta: optionalBoolean(args, "includeVideoMeta"),
        },
        { dryRun },
      );

    case "analyzePlaylist":
      return service.analyzePlaylist(
        {
          playlistUrlOrId: readString(args, "playlistUrlOrId"),
          analyses: readStringArray(args, "analyses") as Array<
            "video_info" | "transcript" | "comments" | "sentiment" | "hook_patterns" | "tag_title_patterns"
          >,
          maxVideos: optionalNumber(args, "maxVideos"),
          commentsSampleSize: optionalNumber(args, "commentsSampleSize"),
          transcriptMode: optionalEnum(args, "transcriptMode", ["summary", "key_moments", "full"]),
        },
        { dryRun },
      );

    case "importPlaylist":
      return service.importPlaylist(
        {
          playlistUrlOrId: readString(args, "playlistUrlOrId"),
          collectionId: optionalString(args, "collectionId"),
          maxVideos: optionalNumber(args, "maxVideos"),
          chunkStrategy: optionalEnum(args, "chunkStrategy", ["time_window", "chapters", "auto"]),
          chunkSizeSec: optionalNumber(args, "chunkSizeSec"),
          chunkOverlapSec: optionalNumber(args, "chunkOverlapSec"),
          language: optionalString(args, "language"),
          reindexExisting: optionalBoolean(args, "reindexExisting"),
          label: optionalString(args, "label"),
          embeddingProvider: optionalEnum(args, "embeddingProvider", ["local", "gemini"]),
          embeddingModel: optionalString(args, "embeddingModel"),
          embeddingDimensions: optionalNumber(args, "embeddingDimensions"),
          activateCollection: optionalBoolean(args, "activateCollection"),
        },
        { dryRun },
      );

    case "importVideos":
      return service.importVideos(
        {
          videoIdsOrUrls: readStringArray(args, "videoIdsOrUrls"),
          collectionId: optionalString(args, "collectionId"),
          chunkStrategy: optionalEnum(args, "chunkStrategy", ["time_window", "chapters", "auto"]),
          chunkSizeSec: optionalNumber(args, "chunkSizeSec"),
          chunkOverlapSec: optionalNumber(args, "chunkOverlapSec"),
          language: optionalString(args, "language"),
          reindexExisting: optionalBoolean(args, "reindexExisting"),
          label: optionalString(args, "label"),
          embeddingProvider: optionalEnum(args, "embeddingProvider", ["local", "gemini"]),
          embeddingModel: optionalString(args, "embeddingModel"),
          embeddingDimensions: optionalNumber(args, "embeddingDimensions"),
          activateCollection: optionalBoolean(args, "activateCollection"),
        },
        { dryRun },
      );

    case "searchTranscripts":
      return service.searchTranscripts({
        query: readString(args, "query"),
        collectionId: optionalString(args, "collectionId"),
        maxResults: optionalNumber(args, "maxResults"),
        minScore: optionalNumber(args, "minScore"),
        videoIdFilter: optionalStringArray(args, "videoIdFilter"),
        useActiveCollection: optionalBoolean(args, "useActiveCollection"),
      });

    case "listCollections":
      return service.listCollections({
        includeVideoList: optionalBoolean(args, "includeVideoList"),
      });

    case "setActiveCollection":
      return service.setActiveCollection({
        collectionId: readString(args, "collectionId"),
      });

    case "clearActiveCollection":
      return service.clearActiveCollection();

    case "checkImportReadiness":
      return service.checkImportReadiness(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          language: optionalString(args, "language"),
        },
        { dryRun },
      );

    case "buildVideoDossier":
      return service.buildVideoDossier(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          commentSampleSize: optionalNumber(args, "commentSampleSize"),
          includeComments: optionalBoolean(args, "includeComments"),
          includeSentiment: optionalBoolean(args, "includeSentiment"),
          includeTranscriptSummary: optionalBoolean(args, "includeTranscriptSummary"),
        },
        { dryRun },
      );

    case "checkSystemHealth":
      return service.checkSystemHealth(
        {
          runLiveChecks: optionalBoolean(args, "runLiveChecks"),
        },
        { dryRun },
      );

    case "removeCollection":
      return service.removeCollection({
        collectionId: readString(args, "collectionId"),
      });

    case "scoreHookPatterns":
      return service.scoreHookPatterns(
        {
          videoIdsOrUrls: readStringArray(args, "videoIdsOrUrls"),
          hookWindowSec: optionalNumber(args, "hookWindowSec"),
        },
        { dryRun },
      );

    case "researchTagsAndTitles":
      return service.researchTagsAndTitles(
        {
          seedTopic: readString(args, "seedTopic"),
          regionCode: optionalString(args, "regionCode"),
          language: optionalString(args, "language"),
          maxExamples: optionalNumber(args, "maxExamples"),
        },
        { dryRun },
      );

    case "compareShortsVsLong":
      return service.compareShortsVsLong(
        {
          channelIdOrHandleOrUrl: readString(args, "channelIdOrHandleOrUrl"),
          lookbackDays: optionalNumber(args, "lookbackDays"),
        },
        { dryRun },
      );

    // ── Comment Knowledge Base ──
    case "importComments":
      return service.importComments(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          collectionId: optionalString(args, "collectionId"),
          maxTopLevel: optionalNumber(args, "maxTopLevel"),
          includeReplies: optionalBoolean(args, "includeReplies"),
          maxRepliesPerThread: optionalNumber(args, "maxRepliesPerThread"),
          order: optionalEnum(args, "order", ["relevance", "time"]),
          label: optionalString(args, "label"),
          activateCollection: optionalBoolean(args, "activateCollection"),
        },
        { dryRun },
      );

    case "searchComments":
      return service.searchComments({
        query: readString(args, "query"),
        collectionId: optionalString(args, "collectionId"),
        maxResults: optionalNumber(args, "maxResults"),
        minScore: optionalNumber(args, "minScore"),
        videoIdFilter: optionalStringArray(args, "videoIdFilter"),
        useActiveCollection: optionalBoolean(args, "useActiveCollection"),
      });

    case "listCommentCollections":
      return service.listCommentCollections({
        includeVideoList: optionalBoolean(args, "includeVideoList"),
      });

    case "setActiveCommentCollection":
      return service.setActiveCommentCollection({
        collectionId: readString(args, "collectionId"),
      });

    case "clearActiveCommentCollection":
      return service.clearActiveCommentCollection();

    case "removeCommentCollection":
      return service.removeCommentCollection({
        collectionId: readString(args, "collectionId"),
      });

    case "recommendUploadWindows":
      return service.recommendUploadWindows(
        {
          channelIdOrHandleOrUrl: readString(args, "channelIdOrHandleOrUrl"),
          timezone: readString(args, "timezone"),
          lookbackDays: optionalNumber(args, "lookbackDays"),
        },
        { dryRun },
      );

    case "discoverNicheTrends":
      return service.discoverNicheTrends(
        {
          niche: readString(args, "niche"),
          regionCode: optionalString(args, "regionCode"),
          maxResults: optionalNumber(args, "maxResults"),
          lookbackDays: optionalNumber(args, "lookbackDays"),
        },
        { dryRun },
      );

    case "exploreNicheCompetitors":
      return service.exploreNicheCompetitors(
        {
          niche: readString(args, "niche"),
          regionCode: optionalString(args, "regionCode"),
          maxChannels: optionalNumber(args, "maxChannels"),
        },
        { dryRun },
      );

    // ── Media / Asset tools ──────────────────────────────────
    case "downloadAsset": {
      const mediaStore = getMediaStore();
      const mediaDownloader = getMediaDownloader();
      const videoIdOrUrl = readString(args, "videoIdOrUrl");
      const format = readString(args, "format") as "best_video" | "best_audio" | "thumbnail" | "worst_video";
      const maxSizeMb = optionalNumber(args, "maxSizeMb");
      const result = await mediaDownloader.download({ videoIdOrUrl, format, maxSizeMb });
      const provenance = { sourceTier: "yt_dlp" as const, fetchedAt: new Date().toISOString(), fallbackDepth: 0 as const, partial: false };
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
        provenance,
      };
    }

    case "listMediaAssets": {
      const mediaStore = getMediaStore();
      const videoIdOrUrl = optionalString(args, "videoIdOrUrl");
      const kind = optionalString(args, "kind") as "video" | "audio" | "thumbnail" | "keyframe" | undefined;
      const limit = optionalNumber(args, "limit");

      let assets;
      if (videoIdOrUrl) {
        const videoId = parseVideoId(videoIdOrUrl) ?? videoIdOrUrl;
        assets = mediaStore.listAssetsForVideo(videoId);
        if (kind) assets = assets.filter((a) => a.kind === kind);
        if (limit) assets = assets.slice(0, limit);
      } else {
        assets = mediaStore.listAllAssets({ kind: kind as any, limit });
      }

      const stats = mediaStore.getStats();
      const provenance = { sourceTier: "none" as const, fetchedAt: new Date().toISOString(), fallbackDepth: 0 as const, partial: false };
      return {
        assets: assets.map((a) => ({
          assetId: a.assetId,
          videoId: a.videoId,
          kind: a.kind,
          filePath: a.filePath,
          fileName: a.fileName,
          fileSizeBytes: a.fileSizeBytes,
          mimeType: a.mimeType,
          timestampSec: a.timestampSec,
          width: a.width,
          height: a.height,
          durationSec: a.durationSec,
          createdAt: a.createdAt,
        })),
        stats: {
          totalAssets: stats.totalAssets,
          totalSizeBytes: stats.totalSizeBytes,
          videoCount: stats.videoCount,
          byKind: stats.byKind,
        },
        provenance,
      };
    }

    case "removeMediaAsset": {
      const mediaStore = getMediaStore();
      const assetId = optionalString(args, "assetId");
      const videoIdOrUrl = optionalString(args, "videoIdOrUrl");
      const deleteFiles = readBoolean(args, "deleteFiles", true);

      if (!assetId && !videoIdOrUrl) {
        throw new Error("Provide either assetId or videoIdOrUrl to specify what to remove");
      }

      let removed = 0;
      let freedBytes = 0;

      if (assetId) {
        const asset = mediaStore.getAsset(assetId);
        if (asset) {
          freedBytes = asset.fileSizeBytes;
          mediaStore.removeAsset(assetId, deleteFiles);
          removed = 1;
        }
      } else if (videoIdOrUrl) {
        const videoId = parseVideoId(videoIdOrUrl) ?? videoIdOrUrl;
        const assets = mediaStore.listAssetsForVideo(videoId);
        freedBytes = assets.reduce((sum, a) => sum + a.fileSizeBytes, 0);
        removed = mediaStore.removeVideoAssets(videoId, deleteFiles);
      }

      const provenance = { sourceTier: "none" as const, fetchedAt: new Date().toISOString(), fallbackDepth: 0 as const, partial: false };
      return { removed, freedBytes, provenance };
    }

    case "extractKeyframes": {
      const mediaStore = getMediaStore();
      const thumbnailExtractor = getThumbnailExtractor();
      const videoIdOrUrl = readString(args, "videoIdOrUrl");
      const videoId = parseVideoId(videoIdOrUrl) ?? videoIdOrUrl;
      const result = await thumbnailExtractor.extractKeyframes({
        videoId,
        intervalSec: optionalNumber(args, "intervalSec"),
        maxFrames: optionalNumber(args, "maxFrames"),
        imageFormat: optionalEnum(args, "imageFormat", ["jpg", "png", "webp"]),
        width: optionalNumber(args, "width"),
      });
      const provenance = { sourceTier: "none" as const, fetchedAt: new Date().toISOString(), fallbackDepth: 0 as const, partial: false, sourceNotes: ["Extracted locally via ffmpeg"] };
      return {
        videoId: result.videoId,
        framesExtracted: result.framesExtracted,
        assets: result.assets.map((a) => ({
          assetId: a.assetId,
          filePath: a.filePath,
          timestampSec: a.timestampSec ?? 0,
          width: a.width,
          height: a.height,
          fileSizeBytes: a.fileSizeBytes,
        })),
        durationMs: result.durationMs,
        provenance,
      };
    }

    case "mediaStoreHealth": {
      const mediaStore = getMediaStore();
      const thumbnailExtractor = getThumbnailExtractor();
      const mediaDownloader = getMediaDownloader();
      const stats = mediaStore.getStats();
      let ffmpegAvailable = false;
      let ffmpegVersion: string | undefined;
      let ytdlpAvailable = false;
      let ytdlpVersion: string | undefined;

      try {
        const probeResult = await thumbnailExtractor.probe();
        ffmpegAvailable = true;
        ffmpegVersion = probeResult.ffmpeg;
      } catch { /* unavailable */ }
      try {
        const probeResult = await mediaDownloader.probe();
        ytdlpAvailable = true;
        ytdlpVersion = probeResult.version;
      } catch { /* unavailable */ }

      const provenance = { sourceTier: "none" as const, fetchedAt: new Date().toISOString(), fallbackDepth: 0 as const, partial: false };
      return {
        dataDir: mediaStore.dataDir,
        assetsDir: mediaStore.assetsDir,
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
        provenance,
      };
    }

    case "indexVisualContent":
      return service.indexVisualContent(
        {
          videoIdOrUrl: readString(args, "videoIdOrUrl"),
          intervalSec: optionalNumber(args, "intervalSec"),
          maxFrames: optionalNumber(args, "maxFrames"),
          imageFormat: optionalEnum(args, "imageFormat", ["jpg", "png", "webp"]),
          width: optionalNumber(args, "width"),
          autoDownload: optionalBoolean(args, "autoDownload"),
          downloadFormat: optionalEnum(args, "downloadFormat", ["best_video", "worst_video"]),
          forceReindex: optionalBoolean(args, "forceReindex"),
          includeGeminiDescriptions: optionalBoolean(args, "includeGeminiDescriptions"),
          includeGeminiEmbeddings: optionalBoolean(args, "includeGeminiEmbeddings"),
        },
        { dryRun },
      );

    case "searchVisualContent":
      return service.searchVisualContent(
        {
          query: readString(args, "query"),
          videoIdOrUrl: optionalString(args, "videoIdOrUrl"),
          maxResults: optionalNumber(args, "maxResults"),
          minScore: optionalNumber(args, "minScore"),
          autoIndexIfNeeded: optionalBoolean(args, "autoIndexIfNeeded"),
          intervalSec: optionalNumber(args, "intervalSec"),
          maxFrames: optionalNumber(args, "maxFrames"),
          imageFormat: optionalEnum(args, "imageFormat", ["jpg", "png", "webp"]),
          width: optionalNumber(args, "width"),
          autoDownload: optionalBoolean(args, "autoDownload"),
          downloadFormat: optionalEnum(args, "downloadFormat", ["best_video", "worst_video"]),
          includeGeminiDescriptions: optionalBoolean(args, "includeGeminiDescriptions"),
          includeGeminiEmbeddings: optionalBoolean(args, "includeGeminiEmbeddings"),
        },
        { dryRun },
      );

    case "findSimilarFrames":
      return service.findSimilarFrames(
        {
          assetId: optionalString(args, "assetId"),
          framePath: optionalString(args, "framePath"),
          videoIdOrUrl: optionalString(args, "videoIdOrUrl"),
          maxResults: optionalNumber(args, "maxResults"),
          minSimilarity: optionalNumber(args, "minSimilarity"),
        },
        { dryRun },
      );

    case "exploreYouTube":
      return service.exploreYouTube(
        {
          query: optionalString(args, "query"),
          searches: optionalStringArray(args, "searches"),
          mode: optionalEnum(args, "mode", ["specific", "explore"]),
          creator: optionalString(args, "creator"),
          freshness: optionalEnum(args, "freshness", ["any", "week", "month", "year"]),
          persona: optionalString(args, "persona"),
          maxResults: optionalNumber(args, "maxResults"),
          depth: optionalEnum(args, "depth", ["quick", "standard", "deep"]),
          selectionStrategy: optionalEnum(args, "selectionStrategy", ["best_match", "diverse_set"]),
          prepareVisualSearch: optionalBoolean(args, "prepareVisualSearch"),
          prepareTranscriptSearch: optionalBoolean(args, "prepareTranscriptSearch"),
        },
        { dryRun },
      );

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function parseArgs(input: CallToolRequest["params"]["arguments"]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Argument '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Argument '${key}' must be a string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`Argument '${key}' must be a number`);
  return value;
}

function readBoolean(args: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") throw new Error(`Argument '${key}' must be a boolean`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Argument '${key}' must be a boolean`);
  return value;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Argument '${key}' must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Argument '${key}' must be an array of strings`);
  }
  return value as string[];
}

function optionalEnum<T extends string>(args: Record<string, unknown>, key: string, values: T[]): T | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Argument '${key}' must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function normalizeError(error: unknown): unknown {
  if (error instanceof Error && "detail" in error) {
    const detail = (error as Error & { detail?: unknown }).detail;
    if (detail) {
      return detail;
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    attemptedTiers: [],
  };
}
