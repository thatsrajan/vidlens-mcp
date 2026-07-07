const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID_RE = /^(PL|UU|LL|RD|OLAK5uy_|FL)[A-Za-z0-9_-]+$/;

export type ChannelRef =
  | { type: "id"; value: string }
  | { type: "handle"; value: string }
  | { type: "custom"; value: string }
  | { type: "url"; value: string };

function maybeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    // continue
  }

  if (raw.includes("youtube.com") || raw.includes("youtu.be")) {
    try {
      return new URL(`https://${raw.replace(/^https?:\/\//, "")}`);
    } catch {
      return null;
    }
  }

  return null;
}

export function parseVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  if (VIDEO_ID_RE.test(raw)) {
    return raw;
  }

  const url = maybeUrl(raw);
  if (url) {
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && VIDEO_ID_RE.test(id) ? id : null;
    }

    const queryId = url.searchParams.get("v");
    if (queryId && VIDEO_ID_RE.test(queryId)) {
      return queryId;
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    const markerIndex = pathParts.findIndex((part) => ["embed", "shorts", "live", "v"].includes(part));
    if (markerIndex >= 0) {
      const id = pathParts[markerIndex + 1];
      return id && VIDEO_ID_RE.test(id) ? id : null;
    }

    // A parseable URL with no real video marker (v=, /watch, /shorts, /embed,
    // youtu.be) is NOT a video URL. Do not fabricate an ID from an arbitrary
    // trailing path segment (e.g. youtube.com/c/TechLinked1).
    return null;
  }

  // Non-URL raw strings only: allow the loose fallback for bare fragments.
  const match = raw.match(/(?:v=|\/)([A-Za-z0-9_-]{11})(?:[?&/\s]|$)/);
  return match?.[1] ?? null;
}

export function parsePlaylistId(input: string): string | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  if (PLAYLIST_ID_RE.test(raw)) {
    return raw;
  }

  const url = maybeUrl(raw);
  if (!url) {
    return null;
  }

  const listId = url.searchParams.get("list");
  if (listId && PLAYLIST_ID_RE.test(listId)) {
    return listId;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const playlistMarker = pathParts.findIndex((part) => part === "playlist");
  if (playlistMarker >= 0) {
    const next = pathParts[playlistMarker + 1];
    return next && PLAYLIST_ID_RE.test(next) ? next : null;
  }

  return null;
}

export function parseChannelRef(input: string): ChannelRef | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  if (CHANNEL_ID_RE.test(raw)) {
    return { type: "id", value: raw };
  }

  if (raw.startsWith("@") && raw.length > 1) {
    return { type: "handle", value: raw.slice(1) };
  }

  const url = maybeUrl(raw);
  if (!url) {
    return { type: "custom", value: raw };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { type: "url", value: url.toString() };
  }

  if (parts[0] === "channel" && parts[1] && CHANNEL_ID_RE.test(parts[1])) {
    return { type: "id", value: parts[1] };
  }

  if (parts[0].startsWith("@")) {
    return { type: "handle", value: parts[0].slice(1) };
  }

  if ((parts[0] === "c" || parts[0] === "user") && parts[1]) {
    return { type: "custom", value: parts[1] };
  }

  return { type: "url", value: url.toString() };
}

export function buildVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function buildPlaylistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

export function buildChannelUrl(ref: ChannelRef): string {
  if (ref.type === "id") {
    return `https://www.youtube.com/channel/${ref.value}`;
  }
  if (ref.type === "handle") {
    return `https://www.youtube.com/@${ref.value}`;
  }
  if (ref.type === "custom") {
    return `https://www.youtube.com/${ref.value}`;
  }
  return ref.value;
}
