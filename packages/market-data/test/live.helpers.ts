/** Helpers for live tests: retry ONCE on transient network errors only. */

const NETWORK_ERROR_RE =
  /network failure|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|UND_ERR|terminated|other side closed/i;

function isTransientNetworkError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e instanceof Error; depth++) {
    if (NETWORK_ERROR_RE.test(e.message)) return true;
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && NETWORK_ERROR_RE.test(code)) return true;
    e = e.cause;
  }
  return false;
}

/**
 * Run `fn`; on a transient NETWORK error retry exactly once after a pause.
 * Schema violations / HTTP errors / assertion failures propagate immediately.
 */
export async function withNetRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    await sleep(1_500);
    return fn();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const LIVE_TIMEOUT = 30_000;
