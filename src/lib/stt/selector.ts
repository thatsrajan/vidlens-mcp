import { GeminiSttProvider } from "./gemini-stt-provider.js";
import { OpenAiWhisperProvider } from "./openai-whisper-provider.js";
import { resolveWhisperCppProvider } from "./whisper-cpp-provider.js";
import type { SttProvider } from "./types.js";
import type { SttProviderId } from "../types.js";

export type SttSelection = SttProviderId | "auto" | "none";

export interface SttSelectionResult {
  provider: SttProvider | null;
  providerId: SttProviderId | "none";
  details: string[];
}

export function selectSttProvider(
  env: NodeJS.ProcessEnv = process.env,
  requestedInput?: SttSelection,
  fetchImpl: typeof fetch = fetch,
): SttSelectionResult {
  const requested = normalizeSelection(requestedInput ?? env.VIDLENS_STT_PROVIDER);
  if (requested === "none") {
    return { provider: null, providerId: "none", details: ["STT disabled by configuration."] };
  }

  if (requested === "auto" || requested === "whisper-cpp") {
    const whisper = resolveWhisperCppProvider(env);
    if (whisper) {
      return { provider: whisper, providerId: "whisper-cpp", details: ["Selected local whisper.cpp provider."] };
    }
    if (requested === "whisper-cpp") {
      return { provider: null, providerId: "none", details: ["whisper.cpp selected but binary/model was not found."] };
    }
  }

  if ((requested === "auto" || requested === "gemini") && (env.GEMINI_API_KEY || env.GOOGLE_API_KEY)) {
    return {
      provider: new GeminiSttProvider(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY!, env.VIDLENS_GEMINI_STT_MODEL),
      providerId: "gemini",
      details: ["Selected Gemini audio provider."],
    };
  }
  if (requested === "gemini") {
    return { provider: null, providerId: "none", details: ["Gemini STT selected but GEMINI_API_KEY/GOOGLE_API_KEY is not set."] };
  }

  if ((requested === "auto" || requested === "openai") && env.OPENAI_API_KEY) {
    return {
      provider: new OpenAiWhisperProvider(env.OPENAI_API_KEY, env.VIDLENS_OPENAI_STT_MODEL, fetchImpl),
      providerId: "openai",
      details: ["Selected OpenAI transcription provider."],
    };
  }
  if (requested === "openai") {
    return { provider: null, providerId: "none", details: ["OpenAI STT selected but OPENAI_API_KEY is not set."] };
  }

  return { provider: null, providerId: "none", details: ["No STT provider configured."] };
}

function normalizeSelection(value: string | undefined): SttSelection {
  switch (value?.trim().toLowerCase()) {
    case "whisper-cpp":
    case "gemini":
    case "openai":
    case "none":
      return value.trim().toLowerCase() as SttSelection;
    default:
      return "auto";
  }
}
