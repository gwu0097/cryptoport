import "server-only";
import { fetchWithRetry } from "./http.ts";

// Every Etherscan V2 call goes through here. The free key allows 3 calls per
// second, shared by everything that uses it (token discovery, the
// Transactions page); a burst answers HTTP 200 with
// {"status":"0","result":"Max calls per sec rate limit reached (3/sec)"}
// (checked 2026-09-25), so it can't be retried on the status code. Paced to
// one call per PACE_MS in this process, and a rate-limit answer waits and
// tries again. Other servers running the same key share the quota; the retry
// covers that.

const API_BASE = "https://api.etherscan.io/v2/api";
const PACE_MS = 350;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 1_100;
let nextSlotAt = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits for this call's turn. With `maxWaitMs`, a caller that would wait
 * longer gives up at once (nothing reserved, no call made). */
async function takeSlot(maxWaitMs?: number): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextSlotAt);
  if (maxWaitMs !== undefined && startAt - now > maxWaitMs) throw new Error(`Etherscan busy (next turn in ${Math.round((startAt - now) / 1000)}s)`);
  nextSlotAt = startAt + PACE_MS;
  if (startAt > now) await sleep(startAt - now);
}

export interface EtherscanBody {
  status: string;
  message: string;
  result: unknown;
}

/** Whether an Etherscan answer is its per-second rate limit (pure). */
export function isRateLimited(body: EtherscanBody): boolean {
  return body.status === "0" && /rate limit/i.test(`${body.message} ${typeof body.result === "string" ? body.result : ""}`);
}

/** One Etherscan V2 call for `chainId`, paced and retried on its rate
 * limit. Returns the parsed body; the caller decides what status "0" means
 * (it covers both "nothing found" and real errors). `maxWaitMs`: throw
 * instead of queueing longer than this (a best-effort caller). */
export async function etherscanFetch(chainId: number, params: Record<string, string>, opts: { maxWaitMs?: number } = {}): Promise<EtherscanBody> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY not set");
  const qs = new URLSearchParams({ chainid: String(chainId), apikey: key, ...params });
  for (let attempt = 0; ; attempt++) {
    await takeSlot(opts.maxWaitMs);
    const res = await fetchWithRetry(`${API_BASE}?${qs.toString()}`);
    if (!res.ok) throw new Error(`Etherscan (chain ${chainId}): HTTP ${res.status}`);
    const body = (await res.json()) as EtherscanBody;
    if (!isRateLimited(body) || attempt === RATE_LIMIT_RETRIES) return body;
    nextSlotAt = Math.max(nextSlotAt, Date.now() + RATE_LIMIT_WAIT_MS); // everyone waits
  }
}
