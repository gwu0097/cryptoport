// Pure ranking logic for the Trend Finder feature — no DB, no network, so
// this is directly unit-testable with `node --test`, separate from the
// correlation math (correlation.ts) and the CoinGecko/DB-fetching
// orchestration in trendPeers.ts.
//
// v2: replaces category-membership-based peer ranking (a coin's narrowest
// CoinGecko category) with price-correlation-based ranking. Reported
// directly, with a screenshot: AVAX's "narrowest" category was still
// "Proof of Stake" — $566B, containing ETH/BNB/TRX and a junk exchange
// token alongside real peers. No denylist or tier change fixes that; it's
// a structural ceiling of CoinGecko's category data for major coins. See
// correlation.ts's own doc comment for the live-verified numbers behind
// the new method (factor-adjusted hourly-return correlation).

/** A universe member with a computed correlation, before the market-cap
 * floor is applied — marketCap stays nullable here (CoinGecko occasionally
 * has no market-cap figure for a coin) since rankPeers is what turns "no
 * cap known" into "excluded," not the shape itself. */
export interface CorrelatedCandidate {
  id: string;
  symbol: string;
  imageUrl: string | null;
  price: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  marketCap: number | null;
  /** Pearson correlation of hourly log-returns vs. the seed, with BTC's and
   * ETH's own returns regressed out of both sides first (see
   * correlation.ts). Always present — anything without a computable
   * correlation never becomes a candidate (see trendPeers.ts). */
  correlation: number;
  /** How many aligned hourly observations the correlation above was
   * computed from — gates MIN_OVERLAP_HOURS below. */
  overlapHours: number;
}

/** rankPeers' own output shape — same candidate fields, with marketCap
 * narrowed to non-null (same "PeerRow extends CategoryMember { marketCap:
 * number }" pattern the old category-based version used): anything that
 * survives rankPeers' market-cap-floor filter has a known market cap by
 * construction, so every downstream display/sort consumer (TrendPeerTable,
 * trend-finder/page.tsx) can rely on that without a null check. */
export interface CorrelatedPeer extends CorrelatedCandidate {
  marketCap: number;
}

/** ~3.5 standard errors from zero at n≈2159 hourly observations (95% CI
 * ±0.042 — see correlation.ts's own doc comment for the derivation). Sits
 * in the measured gap between junk (0.06-0.07: a random exchange token, a
 * low-relevance L1) and real peers (0.25-0.41) from this session's live
 * AVAX test — not an arbitrary round number. */
export const MIN_CORRELATION = 0.15;

/** ~2 weeks of hourly data. Below this, a correlation estimate is too
 * noisy to be a real answer, not just a less precise one — see
 * correlation.ts's own doc comment on why daily-90d's ~90 observations
 * (±0.21 CI) wasn't usable at all. A seed or candidate with a shorter
 * cached/fetched history (a newly listed coin) simply can't be scored yet. */
export const MIN_OVERLAP_HOURS = 336;

const MAX_PEERS = 20;

/**
 * Drops the seed itself, requires both a minimum overlap and a minimum
 * correlation to even be considered a peer (below MIN_CORRELATION isn't "a
 * weak peer" — it's not a peer; this app's data-correctness rule is a
 * missing/unreliable value is never shown as a plausible-looking one),
 * applies the existing market-cap floor control, then sorts by correlation
 * strength descending and caps at MAX_PEERS. Unlike the old category tiers,
 * there is no "keep walking until we find enough" fallback — a seed with no
 * peers clearing the bar genuinely has none in the current universe, and
 * trendPeers.ts reports that honestly rather than padding the list.
 */
export function rankPeers(
  candidates: CorrelatedCandidate[],
  opts: { seedId: string; mcapFloor: number },
): CorrelatedPeer[] {
  return candidates
    .filter((c) => c.id !== opts.seedId)
    .filter((c) => c.overlapHours >= MIN_OVERLAP_HOURS)
    .filter((c) => c.correlation >= MIN_CORRELATION)
    .filter((c): c is CorrelatedPeer => c.marketCap !== null && c.marketCap >= opts.mcapFloor)
    .sort((a, b) => b.correlation - a.correlation)
    .slice(0, MAX_PEERS);
}
