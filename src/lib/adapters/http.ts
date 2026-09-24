import "server-only";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRY_AFTER_MS = 30_000;

/** How long to wait before retry number `attempt` (1-based): exponential
 * backoff (base, x2, x4, ...) with ±20% jitter so concurrent callers don't
 * retry in lockstep, and never sooner than the server's own Retry-After
 * (seconds or an HTTP date; honored up to 30s). Pure — see http.test.ts. */
export function retryDelayMs(attempt: number, baseDelayMs: number, retryAfter: string | null, rand = Math.random(), nowMs = Date.now()): number {
  const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.8 + 0.4 * rand);
  let serverMs = 0;
  if (retryAfter) {
    const secs = Number(retryAfter);
    serverMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - nowMs) || 0;
  }
  return Math.round(Math.max(backoff, Math.min(serverMs, MAX_RETRY_AFTER_MS)));
}

/**
 * Fetches with retry on 429/503 (exponential backoff with jitter:
 * baseDelayMs, then x2, x4, ..., never sooner than a Retry-After header). Rabby's total_balance/token_list rate-limits hard — 6 of 12
 * wallets hit 429 at ~250ms call spacing during design — so callers using
 * this against Rabby should also space consecutive calls (see
 * `sequentialWithSpacing`); this only covers retrying a single call that
 * gets throttled.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  {
    attempts = 3,
    baseDelayMs = 1000,
    stopOn,
  }: {
    attempts?: number;
    baseDelayMs?: number;
    /** A 429/503 this returns true for is handed straight back instead of
     * retried — for a rejection backoff can't fix (e.g. a monthly quota
     * being exhausted, see coingeckoFetch.ts). Gets a clone; the returned
     * response's body is still unread. */
    stopOn?: (res: Response) => Promise<boolean>;
  } = {},
): Promise<Response> {
  let lastError: Error | null = null;
  let retryAfter: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelayMs(attempt, baseDelayMs, retryAfter));
      retryAfter = null;
    }
    try {
      const res = await fetch(url, { ...init, cache: "no-store" });
      if (res.status === 429 || res.status === 503) {
        if (stopOn && (await stopOn(res.clone()))) return res;
        retryAfter = res.headers.get("retry-after");
        lastError = new Error(`HTTP ${res.status} from ${url}`);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e as Error;
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url} after ${attempts} attempts`);
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once —
 * shared by any adapter that needs to fire many requests at a free/keyless
 * API without tripping its burst-rate limiting (originally built for the
 * EVM adapter's chunked Multicall3 calls, reused by the BTC xpub scanner's
 * per-address balance lookups).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Runs async calls one at a time with at least `spacingMs` between the
 * *start* of consecutive calls, collecting per-item results — one call's
 * rejection never stops the rest (same "one ticker's failure never touches
 * another's" rule as the price refresh job).
 */
export async function sequentialWithSpacing<T, R>(
  items: T[],
  spacingMs: number,
  fn: (item: T) => Promise<R>,
): Promise<{ item: T; result?: R; error?: Error }[]> {
  const results: { item: T; result?: R; error?: Error }[] = [];

  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(spacingMs);
    try {
      results.push({ item: items[i], result: await fn(items[i]) });
    } catch (e) {
      results.push({ item: items[i], error: e as Error });
    }
  }

  return results;
}
