/**
 * innertube-client.ts — Direct YouTube InnerTube transcript fetcher.
 *
 * Vendored from @playzone/youtube-transcript (MIT), converted to ESM TypeScript
 * with native fetch. Zero external dependencies.
 *
 * Flow: fetch watch page → extract InnerTube API key → POST player endpoint →
 *       extract caption tracks → pick best track → fetch + parse XML → TranscriptRecord
 */

import type { TranscriptRecord, TranscriptSegment } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const WATCH_URL = "https://www.youtube.com/watch?v=";
const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player";
const INNERTUBE_CONTEXT = {
  client: { clientName: "ANDROID", clientVersion: "20.10.38" },
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const INNERTUBE_KEY_RE = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/;

// ── Error types ──────────────────────────────────────────────────────────────

export class InnertubeError extends Error {
  constructor(
    message: string,
    public readonly videoId: string,
    public readonly code:
      | "TRANSCRIPTS_DISABLED"
      | "VIDEO_UNAVAILABLE"
      | "AGE_RESTRICTED"
      | "IP_BLOCKED"
      | "REQUEST_BLOCKED"
      | "NO_TRANSCRIPT_FOUND"
      | "PARSE_FAILED"
      | "NETWORK_ERROR",
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "InnertubeError";
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface TranscriptLanguageInfo {
  languageCode: string;
  language: string;
  isGenerated: boolean;
  isTranslatable: boolean;
}

/**
 * Fetch a transcript directly via YouTube's InnerTube API.
 * No yt-dlp binary, no API key, no OAuth required.
 */
export async function fetchTranscript(
  videoId: string,
  languageHint?: string,
): Promise<TranscriptRecord> {
  const captionsData = await fetchCaptionsData(videoId);
  const tracks = captionsData.captionTracks as CaptionTrack[];
  if (!tracks || tracks.length === 0) {
    throw new InnertubeError(
      `No caption tracks available for ${videoId}`,
      videoId,
      "TRANSCRIPTS_DISABLED",
    );
  }

  const picked = pickBestTrack(tracks, languageHint);
  if (!picked) {
    throw new InnertubeError(
      `No transcript found for requested languages on ${videoId}`,
      videoId,
      "NO_TRANSCRIPT_FOUND",
    );
  }

  const xmlUrl = picked.track.baseUrl.replace("&fmt=srv3", "");
  const xmlResponse = await fetchWithHeaders(xmlUrl);
  if (!xmlResponse.ok) {
    throw new InnertubeError(
      `Failed to fetch transcript XML: HTTP ${xmlResponse.status}`,
      videoId,
      "NETWORK_ERROR",
      true,
    );
  }

  const rawXml = await xmlResponse.text();
  const segments = parseTranscriptXml(rawXml);
  if (segments.length === 0) {
    throw new InnertubeError(
      `Transcript XML parsed but contained no usable text for ${videoId}`,
      videoId,
      "PARSE_FAILED",
    );
  }

  const transcriptText = segments.map((s) => s.text).join(" ").trim();

  return {
    videoId,
    languageUsed: picked.languageCode,
    sourceType: picked.isGenerated ? "auto_caption" : "manual_caption",
    confidence: picked.isGenerated ? 0.68 : 0.92,
    transcriptText,
    segments,
  };
}

/**
 * List available transcript languages for a video.
 */
export async function listTranscriptLanguages(
  videoId: string,
): Promise<TranscriptLanguageInfo[]> {
  const captionsData = await fetchCaptionsData(videoId);
  const tracks = captionsData.captionTracks as CaptionTrack[];
  if (!tracks || tracks.length === 0) {
    return [];
  }

  return tracks.map((track) => ({
    languageCode: track.languageCode,
    language: track.name?.runs?.[0]?.text ?? track.languageCode,
    isGenerated: track.kind === "asr",
    isTranslatable: Boolean(track.isTranslatable),
  }));
}

// ── Internal: InnerTube interaction ──────────────────────────────────────────

interface CaptionTrack {
  baseUrl: string;
  name: { runs: Array<{ text: string }> };
  languageCode: string;
  kind?: string; // "asr" = auto-generated
  isTranslatable?: boolean;
}

interface CaptionsData {
  captionTracks: CaptionTrack[];
  translationLanguages?: Array<{ languageCode: string; languageName: { runs: Array<{ text: string }> } }>;
}

async function fetchCaptionsData(videoId: string): Promise<CaptionsData> {
  // Step 1: Fetch the watch page HTML to extract InnerTube API key
  let html = await fetchWatchPageHtml(videoId);

  // Handle GDPR consent wall
  if (html.includes('action="https://consent.youtube.com/s"')) {
    const consentMatch = html.match(/name="v" value="(.*?)"/);
    if (!consentMatch) {
      throw new InnertubeError("Failed to create consent cookie", videoId, "REQUEST_BLOCKED", true);
    }
    // Retry with consent cookie
    html = await fetchWatchPageHtml(videoId, `CONSENT=YES+${consentMatch[1]}`);
  }

  // Step 2: Extract InnerTube API key
  const keyMatch = html.match(INNERTUBE_KEY_RE);
  if (!keyMatch?.[1]) {
    if (html.includes('class="g-recaptcha"')) {
      throw new InnertubeError("YouTube is blocking requests (reCAPTCHA)", videoId, "IP_BLOCKED");
    }
    throw new InnertubeError("Could not extract InnerTube API key from watch page", videoId, "PARSE_FAILED");
  }
  const apiKey = keyMatch[1];

  // Step 3: POST to InnerTube player endpoint
  const playerResponse = await fetchWithHeaders(
    `${INNERTUBE_API_URL}?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId }),
    },
  );

  if (!playerResponse.ok) {
    throw new InnertubeError(
      `InnerTube player API returned HTTP ${playerResponse.status}`,
      videoId,
      "NETWORK_ERROR",
      true,
    );
  }

  const playerData = (await playerResponse.json()) as Record<string, unknown>;

  // Step 4: Assert playability
  assertPlayability(playerData, videoId);

  // Step 5: Extract captions
  const captions = (playerData as { captions?: { playerCaptionsTracklistRenderer?: CaptionsData } })
    .captions?.playerCaptionsTracklistRenderer;

  if (!captions?.captionTracks) {
    throw new InnertubeError("Subtitles are disabled for this video", videoId, "TRANSCRIPTS_DISABLED");
  }

  return captions;
}

async function fetchWatchPageHtml(videoId: string, cookie?: string): Promise<string> {
  const headers: Record<string, string> = {
    "Accept-Language": "en-US",
    "User-Agent": USER_AGENT,
  };
  if (cookie) {
    headers["Cookie"] = `${cookie}; Domain=.youtube.com`;
  }

  const response = await fetch(`${WATCH_URL}${videoId}`, { headers });
  if (!response.ok) {
    throw new InnertubeError(
      `Failed to fetch watch page: HTTP ${response.status}`,
      videoId,
      "NETWORK_ERROR",
      true,
    );
  }

  const html = await response.text();
  return unescapeHtml(html);
}

function assertPlayability(playerData: Record<string, unknown>, videoId: string): void {
  const status = playerData.playabilityStatus as
    | { status?: string; reason?: string; errorScreen?: { playerErrorMessageRenderer?: { subreason?: { runs?: Array<{ text: string }> } } } }
    | undefined;

  if (!status?.status || status.status === "OK") return;

  const reason = status.reason ?? "";

  if (status.status === "LOGIN_REQUIRED") {
    if (reason.includes("bot")) {
      throw new InnertubeError("YouTube detected bot-like behavior", videoId, "REQUEST_BLOCKED", true);
    }
    if (reason.includes("inappropriate")) {
      throw new InnertubeError("Video is age-restricted", videoId, "AGE_RESTRICTED");
    }
  }

  if (status.status === "ERROR" && reason.includes("unavailable")) {
    throw new InnertubeError("Video is unavailable", videoId, "VIDEO_UNAVAILABLE");
  }

  const subreasons = status.errorScreen?.playerErrorMessageRenderer?.subreason?.runs
    ?.map((r) => r.text)
    .filter(Boolean) ?? [];
  const detail = subreasons.length > 0 ? ` (${subreasons.join("; ")})` : "";
  throw new InnertubeError(
    `Video unplayable: ${reason}${detail}`,
    videoId,
    "VIDEO_UNAVAILABLE",
  );
}

// ── Internal: Track selection ────────────────────────────────────────────────

function pickBestTrack(
  tracks: CaptionTrack[],
  languageHint?: string,
): { track: CaptionTrack; languageCode: string; isGenerated: boolean } | null {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const auto = tracks.filter((t) => t.kind === "asr");

  // Priority: manual captions first, then auto-generated
  const candidateLanguages = [languageHint, "en", "en-US", "en-GB"].filter(
    (v): v is string => Boolean(v),
  );

  // Try each language in priority order, manual first
  for (const lang of candidateLanguages) {
    const manualHit = manual.find((t) => matchLanguage(t.languageCode, lang));
    if (manualHit) {
      return { track: manualHit, languageCode: manualHit.languageCode, isGenerated: false };
    }
    const autoHit = auto.find((t) => matchLanguage(t.languageCode, lang));
    if (autoHit) {
      return { track: autoHit, languageCode: autoHit.languageCode, isGenerated: true };
    }
  }

  // Fallback: first manual, then first auto
  if (manual.length > 0) {
    return { track: manual[0], languageCode: manual[0].languageCode, isGenerated: false };
  }
  if (auto.length > 0) {
    return { track: auto[0], languageCode: auto[0].languageCode, isGenerated: true };
  }

  return null;
}

function matchLanguage(trackLang: string, requested: string): boolean {
  const a = trackLang.toLowerCase();
  const b = requested.toLowerCase();
  return a === b || a.startsWith(b + "-") || b.startsWith(a + "-");
}

// ── Internal: XML transcript parsing (no xml2js) ────────────────────────────

/**
 * Parses YouTube's transcript XML format:
 *   <transcript><text start="0" dur="3.2">Hello</text>...</transcript>
 *
 * Uses simple regex — the format is flat and predictable, no need for a full
 * XML parser.
 */
export function parseTranscriptXml(rawXml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const textTagRe = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;

  let match: RegExpExecArray | null;
  while ((match = textTagRe.exec(rawXml)) !== null) {
    const start = parseFloat(match[1]);
    const dur = match[2] ? parseFloat(match[2]) : undefined;
    const rawText = match[3];

    // Strip HTML tags and decode entities
    const text = decodeXmlEntities(rawText.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();

    if (!text || isNaN(start)) continue;

    segments.push({
      tStartSec: start,
      tEndSec: dur !== undefined && !isNaN(dur) ? start + dur : undefined,
      text,
    });
  }

  return segments;
}

// ── Internal: Utilities ──────────────────────────────────────────────────────

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function unescapeHtml(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

async function fetchWithHeaders(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", USER_AGENT);
  }
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", "en-US");
  }
  return fetch(url, { ...init, headers });
}
