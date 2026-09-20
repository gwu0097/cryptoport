import "server-only";
import { fetchHourlyHistory, fetchTopCoinsByMarketCap } from "./adapters/coingecko";
import { serviceDb } from "./supabase";

/** Exported so trendPeers.ts's live display-data fetch (price/1h/24h/7d/
 * market cap — never cached, see that file's own comment) requests exactly
 * the same top-N slice this cron treats as universe membership, rather than
 * a second hardcoded number that could drift out of sync with this one. */
export const UNIVERSE_SIZE = 250;
const HISTORY_DAYS = 90;
// Same CoinGecko market_chart rate-limit priceHistory.ts already documents
// live-verifying (429s well under this app's usual concurrency).
const SPACING_MS = 3000;
// Headroom under this route's 300s maxDuration — see priceHistory.ts's own
// TIME_BUDGET_MS comment for why this is a wall-clock budget, not a fixed
// item count: fetchWithRetry's backoff on a bad run can stretch real
// duration well past an optimistic per-item estimate.
const TIME_BUDGET_MS = 280_000;
// ~20h, not 24h — a cron scheduled "once daily" can drift a few minutes
// run to run; this avoids an entry ping-ponging between "stale" and "just
// refreshed" across consecutive runs.
const STALE_MS = 20 * 60 * 60 * 1000;

// Always kept warm regardless of market-cap rank — every correlation
// computation in correlation.ts needs these two as factors, seed or not.
const ALWAYS_INCLUDED = ["bitcoin", "ethereum"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refreshes cryptoport.coin_hourly_series for the top UNIVERSE_SIZE coins
 * by market cap (plus BTC/ETH) — Trend Finder's peer candidate pool, now
 * market-cap-scoped instead of category-scoped (see correlation.ts's own
 * doc comment for why the redesign happened). One market_chart call per
 * coin at SPACING_MS, so a 250-coin universe doesn't fit in one run:
 * refreshes the STALEST entries first and stops at TIME_BUDGET_MS, the
 * same incremental shape as backfillPriceHistory (priceHistory.ts) — each
 * coin's row is written the moment it's fetched, so a mid-run stop (or a
 * platform-forced kill) keeps whatever's already done, and the next cron
 * tick continues with the next-stalest batch rather than redoing this run.
 * A 90-day window that takes ~2-3 runs to fully rotate is still ~97% the
 * same data day to day, so a partially-stale universe is a sound tradeoff
 * for a correlation estimate, not a real correctness gap.
 */
export async function refreshCorrelationUniverse(): Promise<{ refreshed: number; failed: number }> {
  const db = serviceDb();
  const [topCoins, existing] = await Promise.all([
    fetchTopCoinsByMarketCap(UNIVERSE_SIZE),
    db.from("coin_hourly_series").select("coingecko_id, updated_at"),
  ]);
  if (existing.error) throw new Error(`Failed to load coin_hourly_series: ${existing.error.message}`);

  const ids = [...new Set([...ALWAYS_INCLUDED, ...topCoins.map((c) => c.id)])];
  const updatedAtById = new Map(
    (existing.data as { coingecko_id: string; updated_at: string }[]).map((r) => [r.coingecko_id, r.updated_at]),
  );

  const now = Date.now();
  const stale = ids
    .filter((id) => {
      const ts = updatedAtById.get(id);
      return !ts || now - new Date(ts).getTime() > STALE_MS;
    })
    .sort((a, b) => {
      const ta = updatedAtById.get(a);
      const tb = updatedAtById.get(b);
      // Never-fetched (no row at all) sorts before merely-stale.
      if (!ta && !tb) return 0;
      if (!ta) return -1;
      if (!tb) return 1;
      return new Date(ta).getTime() - new Date(tb).getTime();
    });

  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;

  for (let i = 0; i < stale.length; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    if (i > 0) await sleep(SPACING_MS);

    const id = stale[i];
    try {
      const points = await fetchHourlyHistory(id, HISTORY_DAYS);
      const series = Object.fromEntries(points.map((p) => [p.hour, p.usd]));
      const { error } = await db
        .from("coin_hourly_series")
        .upsert({ coingecko_id: id, series, updated_at: new Date().toISOString() }, { onConflict: "coingecko_id" });
      if (error) throw new Error(`Failed to save coin_hourly_series for ${id}: ${error.message}`);
      refreshed++;
    } catch {
      // One coin's transient failure (rate limit, network blip) never stops
      // the rest — same "one ticker's failure never touches another's" rule
      // as the price refresh job. No row written, so it's retried (as
      // "never-fetched", highest priority) on the next run.
      failed++;
    }
  }

  return { refreshed, failed };
}

/** Plain read of the whole cached universe (~250-252 rows — small enough
 * for one unfiltered query, no .in()/chunking needed) — trendPeers.ts's
 * correlation compute step. refreshCorrelationUniverse above is solely
 * responsible for deciding membership (top-N by market cap + BTC/ETH); this
 * just returns whatever it's currently populated, which is deliberately
 * how "the universe" gets defined on the read side too. Via serviceDb(),
 * matching coin_categories' own read pattern (getCoinCategories in
 * trendPeers.ts): app-wide reference data with no per-user RLS grant, never
 * read directly by a client session. */
export async function getUniverseSeries(): Promise<Map<string, Map<string, number>>> {
  const db = serviceDb();
  const { data, error } = await db.from("coin_hourly_series").select("coingecko_id, series");
  if (error) throw new Error(`Failed to load coin_hourly_series: ${error.message}`);

  const map = new Map<string, Map<string, number>>();
  for (const row of data as { coingecko_id: string; series: Record<string, number> }[]) {
    map.set(row.coingecko_id, new Map(Object.entries(row.series)));
  }
  return map;
}
