import "server-only";
import { serviceDb, userDb } from "./supabase";
import { fetchDailyHistory } from "./adapters/coingecko";
import { resolveCoingeckoKey } from "./priceKey";
import { buildHistoryMap, isBackfillableKey, type PriceHistoryMap } from "./analytics";
import type { Holding } from "./types";

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
  holdings: Pick<Holding, "price_key">[],
): Promise<{ keysFetched: number; keysFailed: number; keysRemaining: number }> {
  // Stored under each asset's price_key; only CoinGecko coins have a
  // history to fetch (jup:/hl:/coinbase: build theirs from daily closes).
  const keys = [...new Set(holdings.map((h) => h.price_key).filter((k): k is string => !!k && isBackfillableKey(k)))];
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

type HistoryHolding = Pick<Holding, "ticker" | "source" | "contract" | "chain" | "coingecko_id" | "price_key">;

/** Each held asset's daily prices, keyed by price_key, from three layers
 * (later ones win for a day both have):
 *  1. price_history under the holding's pre-price_key history key
 *     (`platform:contract` or a native coin id) — the 365-day backfills
 *     made before history moved to price_key, read in place;
 *  2. price_history under the price_key itself (backfills since);
 *  3. asset_price_daily — the daily snapshot's close of asset_prices, the
 *     only history for jup:/hl:/coinbase: assets.
 * `fetched` names the keys with a backfill row (under either name), which
 * analytics.ts's estimateCoverage uses to tell "backfill can still help"
 * from "CoinGecko has none". Through userDb(): both tables are readable by any signed-in
 * user (shared market data). */
export async function getPriceHistoryMap(holdings: HistoryHolding[]): Promise<{ history: PriceHistoryMap; fetched: Set<string> }> {
  const legacyOf = new Map<string, Set<string>>();
  for (const h of holdings) {
    if (!h.price_key) continue;
    const set = legacyOf.get(h.price_key) ?? new Set<string>();
    const legacy = resolveCoingeckoKey({ ticker: h.ticker, source: h.source, contract: h.contract, chain: h.chain, coingeckoId: h.coingecko_id });
    if (legacy && legacy !== h.price_key) set.add(legacy);
    legacyOf.set(h.price_key, set);
  }
  const keys = [...legacyOf.keys()];
  if (keys.length === 0) return { history: new Map(), fetched: new Set() };

  const db = await userDb();
  const historyKeys = [...new Set([...keys, ...[...legacyOf.values()].flatMap((s) => [...s])])];
  const series = new Map<string, Record<string, number>>();
  for (let i = 0; i < historyKeys.length; i += 200) {
    const { data, error } = await db.from("price_history").select("coingecko_key, series").in("coingecko_key", historyKeys.slice(i, i + 200));
    if (error) throw new Error(`Failed to load price history: ${error.message}`);
    for (const row of data as { coingecko_key: string; series: Record<string, number> }[]) series.set(row.coingecko_key, row.series);
  }
  const closes = new Map<string, [string, number][]>();
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("asset_price_daily")
        .select("price_key, day, usd")
        .in("price_key", batch)
        .order("price_key")
        .order("day")
        .range(from, from + 999);
      if (error) throw new Error(`Failed to load daily closes: ${error.message}`);
      for (const r of data as { price_key: string; day: string; usd: number | string }[]) {
        closes.set(r.price_key, [...(closes.get(r.price_key) ?? []), [r.day, Number(r.usd)]]);
      }
      if (data.length < 1000) break;
    }
  }

  // Keys with a backfill row (under either name) — analytics.ts's
  // estimateCoverage: daily closes alone don't make a coin "fetched".
  const fetched = new Set(keys.filter((k) => series.has(k) || [...legacyOf.get(k)!].some((l) => series.has(l))));
  return { history: buildHistoryMap(legacyOf, series, closes), fetched };
}
