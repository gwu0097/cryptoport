// Pure ranking/matching logic for the Trend Finder feature — no DB, no
// network, so this is directly unit-testable with `node --test`, separate
// from the Perplexity/CoinGecko-fetching orchestration in trendPeers.ts.
//
// v3: peers now come from a live, news-grounded AI explanation (see
// adapters/perplexity.ts) plus CoinGecko's own category taxonomy, not price
// correlation (v2) or blind CoinGecko category-narrowing (v1). Reported
// directly: a real recent rotation (ARB moved, NEAR and AVAX followed over
// the next few days) and a real narrative move (NEAR picking up a privacy
// feature and moving alongside ZEC/VVV) are both narrative-driven events a
// price-history method structurally cannot find — live-verified this
// session that contemporaneous price correlation is real but a *lagged*
// "hasn't caught up yet" relationship isn't present in the data at any
// tested lag, while a live Perplexity Agent API call correctly identified
// both a real, dated catalyst for a moving token and genuinely relevant,
// currently-live thematic peers.

export interface PeerRow {
  id: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  price: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  marketCap: number | null;
}

/**
 * Drops the seed itself, applies the market-cap floor, and sorts ascending
 * by 24h change — laggards (haven't moved yet) first, already-moved peers
 * still shown (never hidden — the user's own stated preference: "it can be
 * listed of course but i don't want to chase something that already
 * moved"). Members with unknown 24h change sort last, not treated as flat.
 * Members with unknown market cap are excluded (can't apply the floor to
 * an unknown value — missing is never treated as passing a numeric filter).
 */
export function rankPeers(members: PeerRow[], opts: { seedId: string; mcapFloor: number }): PeerRow[] {
  return members
    .filter((m) => m.id !== opts.seedId)
    .filter((m) => m.marketCap !== null && m.marketCap >= opts.mcapFloor)
    .sort((a, b) => {
      if (a.change24h === null && b.change24h === null) return 0;
      if (a.change24h === null) return 1;
      if (b.change24h === null) return -1;
      return a.change24h - b.change24h;
    });
}
