import "server-only";
import { fetchWithRetry } from "@/lib/adapters/http";
import { chartGridDate } from "../chartGrid";

// Distinct host from adapters/defillama.ts (api.llama.fi, protocols/fees) —
// this is DefiLlama's separate coins/prices service, own rate-limit
// behavior (live-verified: a burst of ~700 concurrent requests triggers a
// hard lockout returning 429 "Please reach out on Twitter or Discord for
// higher usage" that outlasts a single script's own backoff window; serial
// requests with a 1.5s delay ran 200 requests with zero rate-limiting).
const COINS_BASE = "https://coins.llama.fi";

// Live-verified hard ceiling of 500 data points PER CALL, counted across
// every coin in the call — coins × span, not span per coin. Re-verified
// 2026-09-22: 15 coins × span 33 (495) → 200, 15 × 34 (510) → 400
// "Requested 510 data points exceeds the maximum of 500"; 20 × 366 → 400
// "Requested 7320 ...". Phase 1 recorded this as a per-coin cap, and the
// batched (15-coin, span-500) path never completed a run, so the wrong
// reading went unnoticed until the first validation backfill. Depth beyond
// one call needs chained calls, each `start` advanced by the previous span.
const CHART_MAX_POINTS = 500;

// The validated safe throttle (PHASE_1 sign-off) — serial, 1.5s between
// EVERY individual HTTP call to this host, not just between logical
// batches. A real bug caught before it burned another rate-limit lockout:
// an earlier version only slept between batches, letting up to 4 chained
// span-500 calls within one batch fire back-to-back with zero delay —
// exactly the kind of burst that triggered the original lockout. This
// function now owns its own throttle unconditionally rather than trusting
// a caller to space every individual request correctly.
const THROTTLE_MS = 1500;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ChartPricePoint {
  date: string; // UTC calendar date, YYYY-MM-DD
  priceUsd: number;
}

/**
 * Full daily price history for potentially many coins in ONE call each
 * (per span-500 window) — live-verified: /chart/{coins} accepts a comma-
 * separated list of coingecko:id coins in the path and returns each one's
 * own series in the same response, not one call per coin. This is the
 * backtest price-history source per the approved switch away from
 * CoinGecko's public API (hard 365-day cap on that tier, see
 * DATA_SOURCES.md) — CoinGecko stays the live-snapshot price source,
 * unaffected; this is backfill-only.
 *
 * Important, deliberate limitation: this endpoint only ever returns
 * `prices`, never historical market cap or trading volume (live-verified
 * — the response has no market_caps/volumes field at any point in the
 * chain, unlike CoinGecko's market_chart which gives all three). Backfill
 * callers should treat this as PRICE-ONLY depth, not a full replacement
 * for CoinGecko's 365-day price+mcap+volume series — see backfill.ts's
 * own merge logic for how the two are combined without silently dropping
 * mcap/volume for the window where CoinGecko still has it.
 */
export async function fetchChartPrices(
  geckoIds: string[],
  startEpochSeconds: number,
  totalDays: number,
): Promise<Map<string, ChartPricePoint[]>> {
  // Accumulate per-asset as date -> price, not a plain array, so an
  // overlapping boundary between two chained calls (DefiLlama's actual
  // returned timestamps carry real jitter — not exact multiples of
  // 86400s from `start` — so a call's last point and the next call's
  // first point can legitimately land on the same UTC calendar date)
  // dedupes explicitly here rather than relying on a downstream caller's
  // Map to silently absorb the duplicate. Later call wins for a shared
  // date — it's the chronologically later (and, for a jittered boundary,
  // very slightly more current) observation.
  const byAssetByDate = new Map<string, Map<string, number>>(geckoIds.map((id) => [id, new Map()]));
  if (geckoIds.length === 0) return new Map();
  if (geckoIds.length > CHART_MAX_POINTS) throw new Error(`fetchChartPrices: ${geckoIds.length} coins can't fit one call's ${CHART_MAX_POINTS}-point cap`);
  const coinsParam = geckoIds.map((id) => `coingecko:${id}`).join(",");

  let cursor = startEpochSeconds;
  let remaining = totalDays;
  while (remaining > 0) {
    await sleep(THROTTLE_MS);
    const span = Math.min(Math.floor(CHART_MAX_POINTS / geckoIds.length), remaining);
    const res = await fetchWithRetry(`${COINS_BASE}/chart/${coinsParam}?start=${cursor}&span=${span}&period=1d`);
    if (!res.ok) throw new Error(`DefiLlama /chart failed: HTTP ${res.status}`);
    const body: { coins: Record<string, { prices?: { timestamp: number; price: number }[] }> } = await res.json();
    for (const id of geckoIds) {
      const points = body.coins[`coingecko:${id}`]?.prices ?? [];
      const byDate = byAssetByDate.get(id)!;
      for (const p of points) {
        byDate.set(chartGridDate(p.timestamp, startEpochSeconds), p.price);
      }
    }
    remaining -= span;
    cursor += span * 86400;
  }

  const result = new Map<string, ChartPricePoint[]>();
  for (const [id, byDate] of byAssetByDate) {
    result.set(
      id,
      [...byDate.entries()].map(([date, priceUsd]) => ({ date, priceUsd })),
    );
  }
  return result;
}

/** Prices for a few coins now (`atEpochSeconds` omitted) or at a past
 * moment — /prices/current or /prices/historical/{ts}, one call for all
 * coins. Same host and same throttle as fetchChartPrices. */
export async function fetchPricesAt(geckoIds: string[], atEpochSeconds?: number): Promise<Map<string, number>> {
  const coins = geckoIds.map((id) => `coingecko:${id}`).join(",");
  const path = atEpochSeconds === undefined ? `/prices/current/${coins}` : `/prices/historical/${atEpochSeconds}/${coins}`;
  await sleep(THROTTLE_MS);
  const res = await fetchWithRetry(`${COINS_BASE}${path}`);
  if (!res.ok) throw new Error(`DefiLlama ${path.split("/").slice(0, 3).join("/")} failed: HTTP ${res.status}`);
  const body: { coins: Record<string, { price?: number }> } = await res.json();
  const result = new Map<string, number>();
  for (const id of geckoIds) {
    const p = body.coins[`coingecko:${id}`]?.price;
    if (typeof p === "number") result.set(id, p);
  }
  return result;
}
