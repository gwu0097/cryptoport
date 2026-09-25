import "server-only";
import { fetchWithRetry } from "./http";
import { windowDelay } from "../rateWindow";

// Every CoinGecko call in the app goes through here (the shared adapter and
// the screener's own) — the key handling used to be duplicated in both.
//
// Two free Demo keys, primary then backup. The primary hit CoinGecko's
// 10,000 calls/month cap on 2026-09-22 (a full screener backfill on top of
// normal app usage — error_code 10006, "You've reached 10,000 calls
// limit"), which took down every CoinGecko-backed feature until the monthly
// reset. On that specific rejection this switches to the next key for the
// rest of the process's life and retries immediately; an ordinary per-
// minute 429 is still just retried with backoff on the same key. State is
// per server instance, so a cold start re-checks the primary once (one
// rejected call) and resumes using it automatically after its reset.
const KEYS = [process.env.COINGECKO_API_KEY, process.env.COINGECKO_API_KEY_BACKUP].filter(
  (k): k is string => typeof k === "string" && k.length > 0,
);
let active = 0;

export const COINGECKO_HAS_KEY = KEYS.length > 0;

// Per CoinGecko, only 200s deduct monthly credits, but EVERY request counts
// toward the per-minute limit — so a retry that lands in the same minute
// just burns rate-limit headroom. fetchWithRetry's generic default (retry
// after 1s, then 2s) is too eager here; 4s base (then 8s), with jitter and
// Retry-After honored, spreads retries out. Callers with their own spacing
// (MARKETS_FETCH_OPTS: 6s base) still override it.
const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 4_000 };

/** CoinGecko's own error code for the Demo plan's monthly call cap. */
const QUOTA_EXHAUSTED_CODE = 10006;

async function isQuotaExhausted(res: Response): Promise<boolean> {
  if (res.status !== 429) return false;
  try {
    const body: { status?: { error_code?: number } } = await res.json();
    return body.status?.error_code === QUOTA_EXHAUSTED_CODE;
  } catch {
    return false;
  }
}

// App-wide pacing (per server instance): at most CALLS_PER_MINUTE requests
// in any rolling minute, the rest wait their turn — under the Demo plan's
// ~30/min, leaving room for retries. A Refresh prices fires its CoinGecko
// lanes in parallel (~50 calls) and a lane died on an HTTP 429 when they
// all went at once (2026-09-25).
const CALLS_PER_MINUTE = 25;
const recentCalls: number[] = [];

async function takeSlot(): Promise<void> {
  for (;;) {
    const wait = windowDelay(recentCalls, Date.now(), CALLS_PER_MINUTE, 60_000);
    if (wait <= 0) {
      recentCalls.push(Date.now());
      return;
    }
    await new Promise((r) => setTimeout(r, wait + 50));
  }
}

export async function coingeckoFetch(
  url: string,
  opts?: { attempts?: number; baseDelayMs?: number },
): Promise<Response> {
  await takeSlot();
  for (;;) {
    const key = KEYS[active];
    const res = await fetchWithRetry(url, { headers: key ? { "x-cg-demo-api-key": key } : {} }, { ...DEFAULT_RETRY, ...opts, stopOn: isQuotaExhausted });
    if (res.status === 429 && active < KEYS.length - 1 && (await isQuotaExhausted(res.clone()))) {
      console.warn(`[coingecko] key #${active + 1} hit the monthly call cap — switching to key #${active + 2}`);
      active++;
      continue;
    }
    return res;
  }
}
