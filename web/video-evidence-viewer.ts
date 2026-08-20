import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface EvidenceFrame {
  rank: number;
  imageUri?: string;
  videoId: string;
  videoTitle?: string;
  timestampSec: number;
  timestampLabel: string;
  score?: number;
  matchedOn: string[];
  ocrText?: string;
  description?: string;
  explanation?: string;
  sourceVideoUrl?: string;
}

interface EvidenceView {
  kind: "vidlens.video-evidence";
  schemaVersion: 1;
  query: string;
  resultCount: number;
  frames: EvidenceFrame[];
  searchMeta: {
    searchedFrames?: number;
    searchedVideos?: number;
    queryMode?: string;
    embeddingProvider?: string;
  };
  coveredTimeRange?: { startSec: number; endSec: number };
  needsExpansion?: boolean;
  limitations: string[];
  provenance?: Record<string, unknown>;
  timing?: { elapsedMs?: number; tier?: string };
}

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      sendFollowUpMessage?: (input: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown>;
    };
  }
}

const app = new App(
  { name: "VidLens Video Evidence Viewer", version: "1.0.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
);

const state = {
  view: undefined as EvidenceView | undefined,
  filter: "",
  matchType: "all",
  objectUrls: new Set<string>(),
};

const root = requiredElement("app");
const loading = requiredElement("loading");
const error = requiredElement("error");

app.ontoolresult = (result) => {
  const view = parseView(result);
  if (!view) {
    showError("VidLens returned an unsupported evidence payload.");
    return;
  }
  renderView(view);
};

app.onhostcontextchanged = applyHostContext;
app.onerror = (cause) => showError(cause instanceof Error ? cause.message : String(cause));

if (window.parent === window) {
  renderView(demoView());
} else {
  void app.connect()
    .then(() => {
      applyHostContext(app.getHostContext());
      const initial = parseUnknownView(window.openai?.toolOutput);
      if (initial) renderView(initial);
    })
    .catch((cause) => showError(cause instanceof Error ? cause.message : String(cause)));
}

function renderView(view: EvidenceView): void {
  state.view = view;
  state.filter = "";
  state.matchType = "all";
  loading.hidden = true;
  error.hidden = true;
  root.hidden = false;
  root.innerHTML = `
    <header class="hero">
      <div class="eyebrow"><span class="lens-mark"></span> VidLens evidence viewer</div>
      <div class="hero-row">
        <div>
          <h1>${escapeHtml(view.query)}</h1>
          <p class="summary">${summaryText(view)}</p>
        </div>
        <button id="fullscreen" class="icon-button" type="button" title="Open full screen" aria-label="Open full screen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>
        </button>
      </div>
      <div class="metrics">${metricChips(view)}</div>
    </header>
    <section class="toolbar" aria-label="Evidence filters">
      <label class="search-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="filter" type="search" placeholder="Filter titles, OCR, or descriptions" autocomplete="off" />
      </label>
      <div class="segmented" id="match-types">
        <button type="button" data-match="all" class="active">All</button>
        <button type="button" data-match="ocr">OCR</button>
        <button type="button" data-match="semantic">Semantic</button>
      </div>
    </section>
    <section id="results" class="results" aria-live="polite"></section>
    ${view.limitations.length > 0 ? `
      <details class="limitations">
        <summary>Coverage and limitations</summary>
        <ul>${view.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </details>` : ""}
    <footer>
      <span>Local evidence via VidLens</span>
      <span class="footer-dot"></span>
      <span>No local file paths exposed</span>
    </footer>
  `;

  requiredElement("filter").addEventListener("input", (event) => {
    state.filter = (event.target as HTMLInputElement).value.toLowerCase().trim();
    renderCards();
  });
  requiredElement("match-types").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-match]");
    if (!button) return;
    state.matchType = button.dataset.match ?? "all";
    document.querySelectorAll("#match-types button").forEach((element) => {
      element.classList.toggle("active", element === button);
    });
    renderCards();
  });
  requiredElement("fullscreen").addEventListener("click", () => {
    if (window.parent === window) return;
    void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
  });
  renderCards();
}

function renderCards(): void {
  const view = state.view;
  if (!view) return;
  revokeObjectUrls();
  const frames = view.frames.filter((frame) => {
    const haystack = [frame.videoTitle, frame.ocrText, frame.description, frame.explanation]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesText = !state.filter || haystack.includes(state.filter);
    const matchesType = state.matchType === "all" || frame.matchedOn.includes(state.matchType);
    return matchesText && matchesType;
  });
  const results = requiredElement("results");
  if (frames.length === 0) {
    results.innerHTML = `<div class="empty"><strong>No matching frames</strong><span>Try a broader filter.</span></div>`;
    return;
  }

  results.innerHTML = frames.map((frame) => cardHtml(frame)).join("");
  for (const frame of frames) {
    const card = document.querySelector<HTMLElement>(`[data-rank="${frame.rank}"]`);
    if (!card) continue;
    card.querySelector<HTMLButtonElement>("[data-source]")?.addEventListener("click", () => void openSource(frame));
    card.querySelector<HTMLButtonElement>("[data-ask]")?.addEventListener("click", () => void askAboutFrame(frame));
    const image = card.querySelector<HTMLImageElement>("img[data-image]");
    if (image && frame.imageUri && window.parent !== window) void loadFrameImage(frame.imageUri, image);
  }
}

function cardHtml(frame: EvidenceFrame): string {
  const score = typeof frame.score === "number" ? Math.round(frame.score * 100) : undefined;
  const title = frame.videoTitle || frame.videoId || "Video evidence";
  const badges = frame.matchedOn.length > 0
    ? frame.matchedOn.map((match) => `<span class="badge">${escapeHtml(match)}</span>`).join("")
    : `<span class="badge neutral">visual</span>`;
  return `
    <article class="card" data-rank="${frame.rank}">
      <div class="media">
        ${frame.imageUri && window.parent !== window
          ? `<img data-image alt="Evidence frame from ${escapeHtml(title)} at ${escapeHtml(frame.timestampLabel)}" />`
          : `<div class="frame-placeholder"><span>${escapeHtml(frame.timestampLabel)}</span><small>Visual evidence</small></div>`}
        <div class="media-top">
          <span class="rank">#${frame.rank}</span>
          ${score === undefined ? "" : `<span class="confidence">${score}% match</span>`}
        </div>
        <button class="timestamp" data-source type="button" ${frame.sourceVideoUrl ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z"/></svg>${escapeHtml(frame.timestampLabel)}
        </button>
      </div>
      <div class="card-body">
        <div class="badges">${badges}</div>
        <h2>${escapeHtml(title)}</h2>
        ${frame.description ? `<p class="description">${escapeHtml(frame.description)}</p>` : ""}
        ${frame.ocrText ? `<details class="ocr"><summary>OCR text</summary><pre>${escapeHtml(frame.ocrText)}</pre></details>` : ""}
        <div class="card-actions">
          <button type="button" data-ask class="ask">Ask about this frame</button>
          ${frame.sourceVideoUrl ? `<button type="button" data-source class="source">Open source <span>↗</span></button>` : ""}
        </div>
      </div>
    </article>`;
}

async function loadFrameImage(uri: string, image: HTMLImageElement): Promise<void> {
  try {
    const result = await app.readServerResource({ uri });
    const content = result.contents[0];
    if (!content || !("blob" in content)) return;
    const bytes = Uint8Array.from(atob(content.blob), (character) => character.charCodeAt(0));
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: content.mimeType ?? "image/jpeg" }));
    state.objectUrls.add(objectUrl);
    image.src = objectUrl;
    image.closest(".media")?.classList.add("image-loaded");
  } catch {
    image.replaceWith(placeholderElement());
  }
}

async function openSource(frame: EvidenceFrame): Promise<void> {
  if (!frame.sourceVideoUrl) return;
  const url = timestampedUrl(frame.sourceVideoUrl, frame.timestampSec);
  if (window.parent !== window && app.getHostCapabilities()?.openLinks) {
    const result = await app.openLink({ url }).catch(() => ({ isError: true }));
    if (!result.isError) return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function askAboutFrame(frame: EvidenceFrame): Promise<void> {
  const prompt = [
    `Analyze VidLens evidence frame #${frame.rank} from ${frame.videoTitle || frame.videoId} at ${frame.timestampLabel}.`,
    frame.description ? `Visual description: ${frame.description}` : "",
    frame.ocrText ? `OCR: ${frame.ocrText}` : "",
    `Relate it to the visual-search query: "${state.view?.query ?? ""}".`,
  ].filter(Boolean).join("\n");

  if (window.parent !== window && app.getHostCapabilities()?.message) {
    await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] }).catch(() => undefined);
    return;
  }
  await window.openai?.sendFollowUpMessage?.({ prompt, scrollToBottom: true });
}

function parseView(result: CallToolResult): EvidenceView | undefined {
  return parseUnknownView(result.structuredContent);
}

function parseUnknownView(value: unknown): EvidenceView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<EvidenceView>;
  if (candidate.kind !== "vidlens.video-evidence" || candidate.schemaVersion !== 1 || !Array.isArray(candidate.frames)) {
    return undefined;
  }
  return candidate as EvidenceView;
}

function applyHostContext(context?: McpUiHostContext): void {
  if (!context) return;
  document.documentElement.dataset.theme = context.theme ?? "light";
  const insets = context.safeAreaInsets;
  if (insets) {
    document.documentElement.style.setProperty("--safe-top", `${insets.top}px`);
    document.documentElement.style.setProperty("--safe-right", `${insets.right}px`);
    document.documentElement.style.setProperty("--safe-bottom", `${insets.bottom}px`);
    document.documentElement.style.setProperty("--safe-left", `${insets.left}px`);
  }
}

function showError(message: string): void {
  loading.hidden = true;
  root.hidden = true;
  error.hidden = false;
  error.innerHTML = `<strong>Evidence viewer unavailable</strong><span>${escapeHtml(message)}</span>`;
}

function summaryText(view: EvidenceView): string {
  const parts = [`${view.resultCount} ranked frame${view.resultCount === 1 ? "" : "s"}`];
  if (view.searchMeta.searchedVideos !== undefined) parts.push(`${view.searchMeta.searchedVideos} video${view.searchMeta.searchedVideos === 1 ? "" : "s"}`);
  if (view.timing?.elapsedMs !== undefined) parts.push(`${(view.timing.elapsedMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

function metricChips(view: EvidenceView): string {
  const chips = [
    view.searchMeta.queryMode ? `<span><b>Mode</b>${escapeHtml(prettyMode(view.searchMeta.queryMode))}</span>` : "",
    view.searchMeta.searchedFrames !== undefined ? `<span><b>Searched</b>${view.searchMeta.searchedFrames} frames</span>` : "",
    view.searchMeta.embeddingProvider ? `<span><b>Embedding</b>${escapeHtml(view.searchMeta.embeddingProvider)}</span>` : "",
    view.coveredTimeRange ? `<span><b>Coverage</b>${formatTime(view.coveredTimeRange.startSec)}–${formatTime(view.coveredTimeRange.endSec)}</span>` : "",
  ].filter(Boolean);
  return chips.join("");
}

function timestampedUrl(source: string, seconds: number): string {
  try {
    const url = new URL(source);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be" || host.endsWith("youtube.com")) url.searchParams.set("t", String(Math.max(0, Math.floor(seconds))));
    if (host === "x.com" || host === "twitter.com") url.searchParams.set("t", `${Math.max(0, Math.floor(seconds))}s`);
    return url.toString();
  } catch {
    return source;
  }
}

function prettyMode(value: string): string {
  return value.replace(/^gemini_/, "").replaceAll("_", " ");
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}

function placeholderElement(): HTMLElement {
  const element = document.createElement("div");
  element.className = "frame-placeholder";
  element.innerHTML = "<span>Frame unavailable</span><small>Metadata remains available</small>";
  return element;
}

function revokeObjectUrls(): void {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function demoView(): EvidenceView {
  return {
    kind: "vidlens.video-evidence",
    schemaVersion: 1,
    query: "architecture diagram and benchmark evidence",
    resultCount: 3,
    frames: [
      {
        rank: 1,
        videoId: "demo",
        videoTitle: "MCP Apps: Extending the Frontier",
        timestampSec: 312,
        timestampLabel: "5:12",
        score: 0.94,
        matchedOn: ["ocr", "semantic"],
        ocrText: "Tool result · resource URI · sandboxed iframe",
        description: "A system diagram showing an MCP tool result linked to an HTML resource rendered by the host.",
      },
      {
        rank: 2,
        videoId: "demo",
        videoTitle: "MCP Apps: Extending the Frontier",
        timestampSec: 428,
        timestampLabel: "7:08",
        score: 0.86,
        matchedOn: ["description", "semantic"],
        description: "The host-to-app bridge uses JSON-RPC messages over postMessage inside a sandboxed iframe.",
      },
      {
        rank: 3,
        videoId: "demo",
        videoTitle: "VidLens visual index",
        timestampSec: 611,
        timestampLabel: "10:11",
        score: 0.78,
        matchedOn: ["ocr"],
        ocrText: "structuredContent · terminal fallback · provenance",
        description: "A comparison slide showing rich GUI rendering and structured terminal output from one MCP server.",
      },
    ],
    searchMeta: {
      searchedFrames: 229,
      searchedVideos: 9,
      queryMode: "gemini_semantic_plus_lexical",
      embeddingProvider: "gemini",
    },
    coveredTimeRange: { startSec: 0, endSec: 1118 },
    limitations: ["Standalone preview uses representative metadata; a connected MCP Apps host loads real local keyframes through opaque resources."],
    timing: { elapsedMs: 146, tier: "fast" },
  };
}

window.addEventListener("beforeunload", revokeObjectUrls);
