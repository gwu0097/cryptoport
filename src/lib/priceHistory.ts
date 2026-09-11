import "server-only";
import { serviceDb, userDb } from "./supabase";
import { fetchDailyHistory } from "./adapters/coingecko";
import { sequentialWithSpacing } from "./adapters/http";
import { resolveCoingeckoKey, type PriceKeyInput } from "./priceKey";
import type { PriceHistoryMap } from "./analytics";

// Live-verified this session: CoinGecko's free/keyless tier throttles a
// burst of market_chart calls almost immediately (5 rapid calls, then 429
// for over two minutes straight) — much tighter than the per-token
// simple/token_price endpoint the rest of this app already calls
// concurrently, so this deliberately does NOT reuse mapWithConcurrency's
// concurrency=4 pattern. Sequential with real spacing between calls
// instead (sequentialWithSpacing, built for exactly this — see http.ts).
const SPACING_MS = 3000;

// Caps one backfill click to a single maxDuration=300s window
// (20 keys * 3s spacing = 60s, generous headroom for retries) rather than
// timing out partway through a large portfolio's first run. Already-cached
// keys are skipped on the next call, so clicking "Backfill history" again
// picks up where this run left off — same "safe to re-run" framing as
// refreshTokenRegistryAction.
const MAX_KEYS_PER_RUN = 20;
const BACKFILL_DAYS = 365;

/**
 * Fills cryptoport.price_history for up to MAX_KEYS_PER_RUN distinct
 * CoinGecko keys among today's holdings that don't already have cached
 * history — an explicit, user-triggered action (see analytics/actions.ts),
 * not something that runs on every page load.
 */
export async function backfillPriceHistory(
  holdings: PriceKeyInput[],
): Promise<{ keysFetched: number; keysFailed: number; keysRemaining: number }> {
  const keys = [...new Set(holdings.map(resolveCoingeckoKey).filter((k): k is string => k !== null))];
  if (keys.length === 0) return { keysFetched: 0, keysFailed: 0, keysRemaining: 0 };

  const db = serviceDb();
  const { data: existing, error } = await db.from("price_history").select("coingecko_key").in("coingecko_key", keys);
  if (error) throw new Error(`Failed to check cached price history: ${error.message}`);

  const alreadyCached = new Set((existing as { coingecko_key: string }[]).map((r) => r.coingecko_key));
  const uncached = keys.filter((k) => !alreadyCached.has(k));
  if (uncached.length === 0) return { keysFetched: 0, keysFailed: 0, keysRemaining: 0 };

  const toFetch = uncached.slice(0, MAX_KEYS_PER_RUN);
  const keysRemaining = uncached.length - toFetch.length;

  const results = await sequentialWithSpacing(toFetch, SPACING_MS, (key) => fetchDailyHistory(key, BACKFILL_DAYS));

  const rows = results
    .filter((r) => r.result && r.result.length > 0)
    .map((r) => ({
      coingecko_key: r.item,
      series: Object.fromEntries(r.result!.map((p) => [p.date, p.usd])),
      fetched_at: new Date().toISOString(),
    }));
  const keysFailed = results.filter((r) => r.error || !r.result || r.result.length === 0).length;

  if (rows.length > 0) {
    const { error: upsertError } = await db.from("price_history").upsert(rows, { onConflict: "coingecko_key" });
    if (upsertError) throw new Error(`Failed to save price history: ${upsertError.message}`);
  }

  return { keysFetched: rows.length, keysFailed, keysRemaining };
}

/** Reads cached history for a set of keys — one query (one row per key,
 * see schema.sql's comment on why this isn't one row per day), shaped for
 * analytics.ts's estimateSeries. Through userDb(): price_history's RLS
 * grants select to any authenticated user (it's shared market data, not
 * per-user), same access level as every other read-only lookup table this
 * app has (token_registry, chain_icons). */
export async function getPriceHistoryMap(keys: string[]): Promise<PriceHistoryMap> {
  const map: PriceHistoryMap = new Map();
  if (keys.length === 0) return map;

  const db = await userDb();
  const { data, error } = await db.from("price_history").select("coingecko_key, series").in("coingecko_key", keys);
  if (error) throw new Error(`Failed to load price history: ${error.message}`);

  for (const row of data as { coingecko_key: string; series: Record<string, number> }[]) {
    map.set(row.coingecko_key, new Map(Object.entries(row.series)));
  }

  return map;
}
