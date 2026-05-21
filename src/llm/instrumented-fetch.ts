import type { RetryInfo } from "./types.ts";

/** Loose fetch signature matching @anthropic-ai/sdk's `Fetch` type.
 *  Bun's global `fetch` is structurally assignable to this. */
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Wraps fetch so we can observe the Anthropic SDK's built-in retries
 * from the outside. The SDK doesn't expose a retry callback, but every
 * retry re-invokes fetch with the same wrapper instance — so a closure
 * counter is enough to detect retry attempts and fire `onRetry`.
 *
 * Fires AFTER the SDK's backoff sleep (when fetch is called again),
 * not before. The "ms-until-next-attempt" signal the old hand-rolled
 * loop reported can't be reconstructed from this vantage point.
 */
export function createInstrumentedFetch(
  onRetry: (info: RetryInfo) => void,
  baseFetch: FetchLike = fetch,
): FetchLike {
  let attempt = 0;
  let lastStatus: number | undefined;
  let lastMessage: string | undefined;

  return async (url, init) => {
    attempt++;
    if (attempt > 1) {
      onRetry({
        attempt: attempt - 1,
        status: lastStatus,
        message: lastMessage,
      });
    }

    try {
      const response = await baseFetch(url, init);
      lastStatus = response.status;
      lastMessage = response.statusText;
      return response;
    } catch (err) {
      lastStatus = undefined;
      lastMessage = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };
}
