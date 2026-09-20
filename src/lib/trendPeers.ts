import "server-only";
import { fetchHourlyHistory, fetchSeedInfo, fetchTopCoinsByMarketCap, type SeedInfo } from "./adapters/coingecko";
import { getUniverseSeries, UNIVERSE_SIZE } from "./correlationUniverse";
import { alignSeries, logReturns, residualizeTwoFactor, pearson } from "./correlation";
import { rankPeers, MIN_OVERLAP_HOURS, type CorrelatedCandidate, type CorrelatedPeer } from "./trendFinder";
import { serviceDb } from "./supabase";

const HISTORY_DAYS = 90;
// Matches the universe's own ~daily refresh cadence (correlationUniverse.ts's
// STALE_MS) — no point recomputing every search when the underlying series
// only actually changes once a day.
const RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedPeer {
  id: string;
  correlation: number;
  overlapHours: number;
}

/** Lazy-populate-on-read cache for one seed's full correlation results
 * against the universe — same shape as coin_categories' old TTL cache
 * (getCoinCategories, this file's previous version), just keyed by seed
 * instead of by coin-and-its-own-categories. Storing the *result* (not
 * just series) is what makes a second search for the same seed instant —
 * the expensive part is the O(universe size) regression pass, not a
 * network call. */
async function getCachedPeers(seedId: string): Promise<CachedPeer[] | null> {
  const { data, error } = await serviceDb()
    .from("coin_correlations")
    .select("peers, computed_at")
    .eq("seed_id", seedId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load coin_correlations: ${error.message}`);

  const row = data as { peers: CachedPeer[]; computed_at: string } | null;
  if (!row) return null;
  const isFresh = Date.now() - new Date(row.computed_at).getTime() < RESULT_CACHE_TTL_MS;
  return isFresh ? row.peers : null;
}

async function cachePeers(seedId: string, peers: CachedPeer[]): Promise<void> {
  const { error } = await serviceDb()
    .from("coin_correlations")
    .upsert({ seed_id: seedId, peers, computed_at: new Date().toISOString() }, { onConflict: "seed_id" });
  if (error) throw new Error(`Failed to cache coin_correlations: ${error.message}`);
}

/** The seed's own hourly series: from the pre-warmed universe if it's a
 * top-250 coin (the common case), else one live fetch — a seed outside the
 * universe (a smaller/newer coin a user searches directly) is rare enough
 * that a single extra CoinGecko call is fine; it's a *burst* of N calls
 * that needs to be cron-driven, not one. Not written back to
 * coin_hourly_series here — that table is exclusively the cron's to
 * populate, so its stale-first ordering (correlationUniverse.ts) stays
 * meaningful; coin_correlations' own cache is what makes a repeat search
 * for this same seed fast instead. */
async function getSeedSeries(
  coingeckoId: string,
  universe: Map<string, Map<string, number>>,
): Promise<Map<string, number> | null> {
  const cached = universe.get(coingeckoId);
  if (cached) return cached;
  const points = await fetchHourlyHistory(coingeckoId, HISTORY_DAYS);
  if (points.length === 0) return null;
  return new Map(points.map((p) => [p.hour, p.usd]));
}

/**
 * Computes BTC+ETH-residual correlation between `seedSeries` and every
 * other series in `universe` — see correlation.ts's own doc comment for
 * why hourly + two-factor is the method. BTC/ETH themselves are always
 * excluded from the output (they're the factors, not candidates — a
 * correlation of a coin against itself/its own factor is meaningless).
 */
function computeCorrelations(
  seedId: string,
  seedSeries: Map<string, number>,
  universe: Map<string, Map<string, number>>,
): CachedPeer[] {
  const btc = universe.get("bitcoin");
  const eth = universe.get("ethereum");
  if (!btc || !eth) return []; // universe cron hasn't populated the factors yet

  const results: CachedPeer[] = [];
  for (const [id, series] of universe) {
    if (id === seedId || id === "bitcoin" || id === "ethereum") continue;

    const keys = alignSeries(seedSeries, series, btc, eth);
    if (keys.length - 1 < MIN_OVERLAP_HOURS) continue;

    const rSeed = logReturns(seedSeries, keys);
    const rCandidate = logReturns(series, keys);
    const rBtc = logReturns(btc, keys);
    const rEth = logReturns(eth, keys);
    // logReturns can drop individual pairs on a bad price point even
    // within an aligned key range — require the four return series to
    // still match in length (they're computed from the same key list, so
    // this only fails if one series had a zero/negative price CoinGecko
    // itself reported, vanishingly rare but not impossible).
    if (rSeed.length !== rCandidate.length || rSeed.length !== rBtc.length || rSeed.length !== rEth.length) continue;

    const residSeed = residualizeTwoFactor(rSeed, rBtc, rEth);
    const residCandidate = residualizeTwoFactor(rCandidate, rBtc, rEth);
    const r = pearson(residSeed, residCandidate);
    if (r === null) continue;

    results.push({ id, correlation: r, overlapHours: rSeed.length });
  }
  return results;
}

export type TrendPeersResult =
  | { status: "no-seed-data"; seedId: string }
  | { status: "no-peers"; seed: SeedInfo }
  | { status: "ok"; seed: SeedInfo; peers: CorrelatedPeer[] };

/**
 * The Trend Finder orchestrator: ranks the current CoinGecko-market-cap
 * universe (correlationUniverse.ts) by how closely each coin's hourly
 * returns have historically tracked the seed's, with BTC's and ETH's own
 * moves regressed out first — replaces the old category-tier walk (see
 * trendFinder.ts's doc comment for why). Own file rather than queries.ts,
 * matching how lookup.ts owns the lookup page's orchestration.
 */
export async function findTrendPeers({
  coingeckoId,
  mcapFloor,
}: {
  coingeckoId: string;
  mcapFloor: number;
}): Promise<TrendPeersResult> {
  const seed = await fetchSeedInfo(coingeckoId);
  if (!seed) return { status: "no-seed-data", seedId: coingeckoId };

  const cached = await getCachedPeers(coingeckoId);
  let correlated: CachedPeer[];

  if (cached) {
    correlated = cached;
  } else {
    const universe = await getUniverseSeries();
    const seedSeries = await getSeedSeries(coingeckoId, universe);
    correlated = seedSeries ? computeCorrelations(coingeckoId, seedSeries, universe) : [];
    await cachePeers(coingeckoId, correlated);
  }

  if (correlated.length === 0) return { status: "no-peers", seed };

  // Display data (price/1h/24h/7d/market cap) is live financial data and is
  // deliberately never cached — coin_hourly_series only stores raw price
  // *history* for the correlation math, not current price for display (the
  // Data Correctness rule: rendering a stale live-financial figure is
  // exactly the plausible-looking wrong number that rule exists to
  // prevent). One call covers virtually the whole candidate set, since
  // correlationUniverse.ts's own membership rule (top-UNIVERSE_SIZE by
  // market cap) is the exact same rule this uses.
  const display = await fetchTopCoinsByMarketCap(UNIVERSE_SIZE);
  const displayById = new Map(display.map((c) => [c.id, c]));

  const candidates = correlated
    .map(({ id, correlation, overlapHours }): CorrelatedCandidate | null => {
      const info = displayById.get(id);
      // Fell out of the top-UNIVERSE_SIZE slice since the last cron run —
      // rare (market caps don't reshuffle that fast) and not an error, just
      // skipped: there's no display data to show for it.
      if (!info) return null;
      return { ...info, correlation, overlapHours };
    })
    .filter((c): c is CorrelatedCandidate => c !== null);

  const peers = rankPeers(candidates, { seedId: coingeckoId, mcapFloor });
  if (peers.length === 0) return { status: "no-peers", seed };
  return { status: "ok", seed, peers };
}
