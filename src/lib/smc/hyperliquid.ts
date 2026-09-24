import "server-only";
import { cache } from "react";
import { fetchWithRetry } from "@/lib/adapters/http";
import type { Candle } from "./engine";
import { WeightBudget, requestWeight } from "./hlWeight";

// Hyperliquid's public info API — free, no key. Signals are computed on the
// venue the user intends to trade on (BACKLOG: "SMC signal engine"), so the
// chart matches what an order would execute against. Live-verified
// 2026-09-22: candleSnapshot returns up to 5,000 candles per call (1h ≈ 208
// days; 4h/1d back to listing), candles open on the UTC hour, and the LAST
// candle returned is the still-forming one (the engine's completeness guard
// handles it).
const INFO_URL = "https://api.hyperliquid.xyz/info";

// Hyperliquid rate-limits /info by request weight per minute per IP (1,200;
// see hlWeight.ts), and this app shares Vercel's egress IPs with other
// tenants. So: a per-process budget (BUDGET_LIMIT, under 1,200) checked
// BEFORE each request, and a 429 is never retried here (a retry spends
// weight into the same exhausted window) — it blocks the budget for a
// minute and throws RateLimitedError, which the Signals data layer answers
// with cached candles and a visible "rate-limited" note. 503s still retry.
const RETRY = { attempts: 3, baseDelayMs: 2000, stopOn: async (r: Response) => r.status === 429 };
const budget = new WeightBudget();

/** The budget (or Hyperliquid itself) says no until `retryAtMs`. */
export class RateLimitedError extends Error {
  readonly retryAtMs: number;
  constructor(retryAtMs: number) {
    super(`Hyperliquid rate budget exhausted until ${new Date(retryAtMs).toISOString()}`);
    this.retryAtMs = retryAtMs;
  }
}

/** Weight spent by the current request (React cache: one per server
 * request), plus whatever meters a caller passes for its own section. */
export interface WeightMeter {
  weight: number;
  requests: number;
}
export const newMeter = (): WeightMeter => ({ weight: 0, requests: 0 });
export const requestMeter = cache(newMeter);

/** This process's spend in the last minute (for the load log). */
export const budgetSpent = () => budget.spent(Date.now());

async function info<T>(body: { type: string }, estimate: number, meters: WeightMeter[] = []): Promise<T> {
  const now = Date.now();
  if (!budget.canSpend(estimate, now)) throw new RateLimitedError(budget.nextFitAt(estimate, now));
  budget.record(estimate, now); // reserve up front, so concurrent requests see it
  const res = await fetchWithRetry(INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, RETRY);
  if (res.status === 429) {
    budget.block(Date.now());
    throw new RateLimitedError(budget.blockedUntil(Date.now()));
  }
  if (!res.ok) throw new Error(`Hyperliquid info ${JSON.stringify(body).slice(0, 60)} failed: HTTP ${res.status}`);
  const data = (await res.json()) as T;
  const actual = requestWeight(body.type, Array.isArray(data) ? data.length : 0);
  budget.record(actual - estimate, Date.now()); // settle the reservation
  for (const m of [requestMeter(), ...meters]) {
    m.weight += actual;
    m.requests += 1;
  }
  return data;
}

// The perp list changes rarely (a listing/delisting) — reused for 10 minutes
// per process instead of costing 20 weight on every page load.
const PERPS_TTL_MS = 10 * 60_000;
let perpsCache: { names: string[]; at: number } | null = null;

/** Active (non-delisted) perp names, e.g. "BTC", "HYPE", "kPEPE". */
export const fetchPerpNames = cache(async (): Promise<string[]> => {
  if (perpsCache && Date.now() - perpsCache.at < PERPS_TTL_MS) return perpsCache.names;
  try {
    const meta = await info<{ universe: { name: string; isDelisted?: boolean }[] }>({ type: "meta" }, 20);
    perpsCache = { names: meta.universe.filter((u) => !u.isDelisted).map((u) => u.name), at: Date.now() };
  } catch (e) {
    if (!perpsCache) throw e; // a slightly old perp list beats none
  }
  return perpsCache.names;
});

/** Live mid price of every Hyperliquid market in ONE call (weight 2), keyed
 * like the perps ("BTC", "kPEPE"). Deduped per request. */
export const fetchAllMids = cache(async (): Promise<Map<string, number>> => {
  const mids = await info<Record<string, string>>({ type: "allMids" }, 2);
  return new Map(Object.entries(mids).map(([k, v]) => [k, Number(v)]));
});

const INTERVAL_MS = { "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as const;

export async function fetchCandles(
  coin: string,
  interval: "1h" | "4h" | "1d",
  startMs: number,
  endMs: number,
  meters: WeightMeter[] = [],
): Promise<Candle[]> {
  const expected = Math.min(5_000, Math.max(1, Math.ceil((endMs - startMs) / INTERVAL_MS[interval]) + 1));
  const rows = await info<{ t: number; o: string; h: string; l: string; c: string; n?: number }[]>(
    { type: "candleSnapshot", req: { coin, interval, startTime: startMs, endTime: endMs } } as { type: string },
    requestWeight("candleSnapshot", expected),
    meters,
  );
  return rows
    .map((r) => ({ t: Math.floor(r.t / 1000), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), n: r.n }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
}

/** Hourly funding rates for a perp since `startMs`, all pages (the endpoint
 * returns at most 500 rows per call, oldest first). A long PAYS a positive
 * rate. Used by the backtest (prereg §4: actual funding over each holding
 * period). `pauseMs` spaces the pages under Hyperliquid's per-minute weight. */
export async function fetchFundingHistory(
  coin: string,
  startMs: number,
  pauseMs = 2500,
): Promise<{ time: number; rate: number }[]> {
  const out: { time: number; rate: number }[] = [];
  let cursor = startMs;
  for (;;) {
    let page: { time: number; fundingRate: string }[];
    try {
      page = await info<{ time: number; fundingRate: string }[]>({ type: "fundingHistory", coin, startTime: cursor } as { type: string }, 20);
    } catch (e) {
      // A batch job (the backtest fetch), not a page load: wait the budget out.
      if (!(e instanceof RateLimitedError)) throw e;
      await new Promise((r) => setTimeout(r, Math.max(1_000, e.retryAtMs - Date.now())));
      continue;
    }
    for (const r of page) out.push({ time: Math.floor(r.time / 1000), rate: Number(r.fundingRate) });
    if (page.length < 500) break;
    cursor = page[page.length - 1].time + 1;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return out;
}
