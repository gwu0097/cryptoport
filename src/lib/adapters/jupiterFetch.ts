import "server-only";
import { fetchWithRetry } from "./http.ts";

// Every api.jup.ag call goes through here. The API key allows 10 requests
// per ~10s window (its x-ratelimit-* headers, checked 2026-09-25) — shared
// by every Solana wallet. "Sync all wallets" runs every wallet's sync in one
// server instance at once, and each Solana wallet makes ~8 Jupiter calls
// (balances, token search, Shield, portfolio, DeFi icon lookups), so nine
// wallets sent ~70 in a burst and every one of them failed with HTTP 429
// (2026-09-25). Paced here instead: one request per PACE_MS, process-wide,
// and a 429 waits for the window's reset before trying again.

const PACE_MS = 1_100;
const MAX_429_RETRIES = 4;
let nextSlotAt = 0;

/** When the next request may start, and the slot after it (pure). */
export function reserveSlot(nowMs: number, nextAtMs: number, paceMs: number): { startAt: number; next: number } {
  const startAt = Math.max(nowMs, nextAtMs);
  return { startAt, next: startAt + paceMs };
}

/** How long a 429 should wait: until the window's reset (epoch seconds in
 * x-ratelimit-reset) plus a little, or 5s without one. */
export function waitAfter429Ms(resetHeader: string | null, nowMs: number): number {
  const reset = Number(resetHeader);
  if (!Number.isFinite(reset) || reset <= 0) return 5_000;
  return Math.min(Math.max(reset * 1000 - nowMs + 250, 1_000), 30_000);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function takeSlot(): Promise<void> {
  const { startAt, next } = reserveSlot(Date.now(), nextSlotAt, PACE_MS);
  nextSlotAt = next;
  if (startAt > Date.now()) await sleep(startAt - Date.now());
}

export async function jupiterFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await takeSlot();
    // Network errors still retried there; a 429/503 comes straight back.
    res = await fetchWithRetry(url, init, { stopOn: async () => true });
    if (res.status !== 429 && res.status !== 503) return res;
    const wait = waitAfter429Ms(res.headers.get("x-ratelimit-reset"), Date.now());
    nextSlotAt = Math.max(nextSlotAt, Date.now() + wait); // everyone waits, not just this caller
  }
  return res!;
}
