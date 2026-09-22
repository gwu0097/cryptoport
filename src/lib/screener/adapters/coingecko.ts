import "server-only";
import { coingeckoFetch } from "@/lib/adapters/coingeckoFetch";

const API_BASE = "https://api.coingecko.com/api/v3";

export interface HistoricalMarketPoint {
  date: string; // UTC calendar date, YYYY-MM-DD
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

/**
 * Backfill-only — the live snapshot path (snapshot.ts) never calls this,
 * it uses the shared adapters/coingecko.ts's fetchMarketsByIds instead
 * (current values only, batched across many ids in one call). This one
 * is per-id (no batch endpoint exists for historical market_chart) and
 * captures market_caps/total_volumes alongside prices — live-verified
 * 2026-09-22 that /coins/{id}/market_chart returns all three arrays
 * together in one response, not just `prices` (which is all the shared
 * adapter's fetchDailyHistory extracts, since that one's only ever used
 * for price charts elsewhere in this app).
 *
 * `days` beyond 365 throws on CoinGecko's free/demo tier — live-verified
 * boundary (see DATA_SOURCES.md): 365 works, 366 doesn't. Callers should
 * never pass more than 365; this function doesn't clamp it for them so a
 * caller passing too much gets a real, loud error rather than silently
 * truncated history.
 */
// Same generosity as the shared adapter's own MARKETS_FETCH_OPTS (see
// coingecko.ts's fetchSeedInfo/fetchCategoryMembers) — live-verified
// during backfill testing that the default 3-attempts/1s-base retry
// wasn't enough to clear a 429/504 reliably under this endpoint's heavier
// per-call cost (365 days of history vs. a lightweight current-value
// lookup) at CONCURRENCY=4.
const HISTORY_FETCH_OPTS = { attempts: 5, baseDelayMs: 6000 };

export async function fetchHistoricalMarketData(coingeckoId: string, days: number): Promise<HistoricalMarketPoint[]> {
  const url = `${API_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await coingeckoFetch(url, HISTORY_FETCH_OPTS);
  if (!res.ok) {
    if (res.status === 404) return []; // CoinGecko has no history at all for this id
    throw new Error(`CoinGecko market_chart(${coingeckoId}) failed: HTTP ${res.status}`);
  }
  const body: { prices?: [number, number][]; market_caps?: [number, number][]; total_volumes?: [number, number][] } =
    await res.json();

  // Bucket each series by UTC calendar date independently (CoinGecko's
  // three arrays aren't guaranteed to share exact timestamps down to the
  // millisecond) and merge by date — the same "collapse to the latest
  // observed value per bucket" rule as the shared adapter's
  // fetchBucketedHistory, applied to three series instead of one.
  function bucket(series: [number, number][] | undefined): Map<string, number> {
    const map = new Map<string, number>();
    for (const [ms, value] of series ?? []) map.set(new Date(ms).toISOString().slice(0, 10), value);
    return map;
  }
  const prices = bucket(body.prices);
  const marketCaps = bucket(body.market_caps);
  const volumes = bucket(body.total_volumes);

  const allDates = new Set([...prices.keys(), ...marketCaps.keys(), ...volumes.keys()]);
  return [...allDates]
    .sort()
    .map((date) => ({
      date,
      priceUsd: prices.get(date) ?? null,
      marketCapUsd: marketCaps.get(date) ?? null,
      volume24hUsd: volumes.get(date) ?? null,
    }));
}
