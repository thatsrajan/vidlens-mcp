import { providerForPlatform } from "./registry.js";

export function getInstagramProvider() {
  return providerForPlatform("instagram");
}
