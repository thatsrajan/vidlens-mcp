import { capabilitiesForPlatform, type VideoSourceRef } from "../video-source.js";
import type { VideoSourcePlatform } from "../types.js";
import type { ProviderContext, ProviderDownloadOptions, ProviderDownloadResult, VideoProvider } from "./types.js";

class BasicProvider implements VideoProvider {
  constructor(readonly platform: VideoSourcePlatform) {}

  capabilities(ctx: ProviderContext) {
    const base = { ...capabilitiesForPlatform(this.platform) };
    if (this.platform !== "youtube" && ctx.stt) {
      base.transcript = true;
      base.transcriptMode = "stt";
      base.notes = base.notes.filter((note) => !note.includes("transcript"));
    }
    if (this.platform === "youtube") {
      base.transcriptMode = "native";
    }
    return base;
  }

  async inspect(ref: VideoSourceRef, ctx: ProviderContext) {
    return {
      source: ref,
      capabilities: this.capabilities(ctx),
      notes: this.capabilities(ctx).notes,
    };
  }

  async download(_ref: VideoSourceRef, _opts: ProviderDownloadOptions, _ctx: ProviderContext): Promise<ProviderDownloadResult> {
    throw new Error("Provider download is handled by MediaDownloader in this release.");
  }
}

const PROVIDERS: Record<VideoSourcePlatform, VideoProvider> = {
  youtube: new BasicProvider("youtube"),
  x: new BasicProvider("x"),
  instagram: new BasicProvider("instagram"),
  tiktok: new BasicProvider("tiktok"),
  generic_url: new BasicProvider("generic_url"),
  local_file: new BasicProvider("local_file"),
};

export function providerForPlatform(platform: VideoSourcePlatform): VideoProvider {
  return PROVIDERS[platform];
}

export function providerForSource(source: VideoSourceRef): VideoProvider {
  return providerForPlatform(source.platform);
}

export function allProviders(): VideoProvider[] {
  return Object.values(PROVIDERS);
}
