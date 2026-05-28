import { providerForPlatform } from "./registry.js";

export function getYouTubeProvider() {
  return providerForPlatform("youtube");
}
