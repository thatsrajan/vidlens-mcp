import { providerForPlatform } from "./registry.js";

export function getGenericUrlProvider() {
  return providerForPlatform("generic_url");
}
