import { providerForPlatform } from "./registry.js";

export function getLocalFileProvider() {
  return providerForPlatform("local_file");
}
