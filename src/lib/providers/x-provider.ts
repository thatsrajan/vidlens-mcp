import { providerForPlatform } from "./registry.js";

export function getXProvider() {
  return providerForPlatform("x");
}
