import "server-only";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches with retry on 429/503 (exponential backoff: baseDelayMs, then x2,
 * x4, ...). Rabby's total_balance/token_list rate-limits hard — 6 of 12
 * wallets hit 429 at ~250ms call spacing during design — so callers using
 * this against Rabby should also space consecutive calls (see
 * `sequentialWithSpacing`); this only covers retrying a single call that
 * gets throttled.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { attempts = 3, baseDelayMs = 1000 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, { ...init, cache: "no-store" });
      if (res.status === 429 || res.status === 503) {
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
