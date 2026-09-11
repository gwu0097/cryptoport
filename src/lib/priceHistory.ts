import "server-only";
import { serviceDb, userDb } from "./supabase";
import { fetchDailyHistory } from "./adapters/coingecko";
import { resolveCoingeckoKey, type PriceKeyInput } from "./priceKey";
import type { PriceHistoryMap } from "./analytics";

// Live-verified this session: CoinGecko's free/keyless tier throttles a
// burst of market_chart calls almost immediately (5 rapid calls, then 429
// for over two minutes straight) — much tighter than the per-token
// simple/token_price endpoint the rest of this app already calls
// concurrently, so this stays strictly sequential with real spacing
// between calls rather than any concurrency.
const SPACING_MS = 3000;
const BACKFILL_DAYS = 365;

// Runs inside analytics/actions.ts's after() callback, sharing that
// route's maxDuration=300s budget with everything else the request does.
// Stops starting new fetches once this much time has elapsed rather than
// capping at a fixed key count — a fixed count risked exceeding
// maxDuration on its own (fetchWithRetry's backoff on a bad run pushes
// real duration well past an optimistic per-key estimate), and the
// platform force-killing the function mid-run would otherwise waste
// whatever was already fetched. Each key's row is written the moment it's
// fetched (not batched at the end) for exactly that reason: a kill after
// key 30 of 40 still keeps those 30, and the next "Backfill history"
// click picks up from key 31.
const TIME_BUDGET_MS = 240_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fills cryptoport.price_history for as many distinct CoinGecko keys
 * among today's holdings as fit in TIME_BUDGET_MS — an explicit,
 * user-triggered action (see analytics/actions.ts), not something that
 * runs on every page load. Safe to click again: only still-uncached keys
 * are considered each time.
 *
 * A key CoinGecko genuinely has no data for (fetchDailyHistory's 404 ->
 * `[]`) still gets a row written, with an empty series — that's a real,
 * permanent answer ("can't price this"), and caching it is what stops a
 * future backfill run from wasting time re-asking CoinGecko the same
 * question forever. A key that failed for a *transient* reason
 * (rate-limited, network blip) gets no row at all, so it's still
 * "uncached" and genuinely retried on the next click.
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

  const startedAt = Date.now();
  let keysFetched = 0;
  let keysFailed = 0;
  let processed = 0;

  for (const key of uncached) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    if (processed > 0) await sleep(SPACING_MS);
    processed++;

    try {
      const points = await fetchDailyHistory(key, BACKFILL_DAYS);
      const series = Object.fromEntries(points.map((p) => [p.date, p.usd]));
      const { error: upsertError } = await db
        .from("price_history")
        .upsert({ coingecko_key: key, series, fetched_at: new Date().toISOString() }, { onConflict: "coingecko_key" });
      if (upsertError) throw new Error(`Failed to save price history for ${key}: ${upsertError.message}`);

      if (points.length > 0) keysFetched++;
      else keysFailed++; // genuine 404, permanently recorded above
    } catch {
      // transient failure — no row written, this key stays uncached
      keysFailed++;
    }
  }

  return { keysFetched, keysFailed, keysRemaining: uncached.length - processed };
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
