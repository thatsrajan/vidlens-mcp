import { providerForPlatform } from "./registry.js";

export function getTikTokProvider() {
  return providerForPlatform("tiktok");
}
