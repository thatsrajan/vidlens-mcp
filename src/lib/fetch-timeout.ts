/**
 * fetch-timeout.ts — a thin wrapper around `fetch` that aborts a request once it
 * exceeds a deadline.
 *
 * Raw `fetch` has no default timeout: a stalled response can hold an MCP tool
 * call open indefinitely. Every network call in the provider layer routes
 * through this helper so a hung server surfaces as an error instead of a hang.
 */

/** Default request timeout for JSON/HTML/text fetches. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Longer timeout for binary downloads (installers, media assets). */
export const DOWNLOAD_FETCH_TIMEOUT_MS = 120_000;

/**
 * Performs a `fetch` that aborts after `timeoutMs`. If the caller supplies its
 * own `signal`, both it and the timeout can abort the request.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? anySignal([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}

/**
 * Combines multiple AbortSignals into one that aborts as soon as any input
 * aborts. (`AbortSignal.any` exists on modern runtimes but is guarded here for
 * portability.)
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn(signals);
  }
  const controller = new AbortController();
  const onAbort = (event: Event): void => {
    controller.abort((event.target as AbortSignal).reason);
    for (const s of signals) {
      s.removeEventListener("abort", onAbort);
    }
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", onAbort);
  }
  return controller.signal;
}
