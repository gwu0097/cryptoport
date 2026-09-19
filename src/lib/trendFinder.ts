// Pure ranking logic for the Trend Finder feature — no DB, no network, so
// this is directly unit-testable with `node --test`, separate from the
// CoinGecko-fetching orchestration in trendPeers.ts.
//
// The core idea, live-verified against the real CoinGecko API: raw category
// *names* are unusable for "find similar tokens" — ARB's "Smart Contract
// Platform" category also contains BTC/DOGE/XRP. Ranking a coin's own
// categories ascending by each category's total market cap fixes this
// without a large hand-maintained allowlist — the giant junk categories
// (Smart Contract Platform at $2.4T, Proof of Work at $1.7T) lose simply by
// being enormous. A small denylist below still catches categories that are
// narrow in market-cap terms but not a real "sector" (e.g. "Arbitrum
// Ecosystem" means deployed-on, not peer-of).

/** Categories cap-ranking alone won't push to the bottom — narrow by market
 * cap, but not a real sector/narrative grouping. Derived from real category
 * lists observed on ARB, AAVE, DOGE, LINK, TAO this session; expect to
 * extend this as more seeds get tried (see the plan's spot-check step). */
const CATEGORY_DENYLIST =
  /ecosystem|portfolio|\bindex\b|launchpool|airdrop|\btge\b|\balpha\b|megadrop|\bido\b|bridged|made in|governance|alleged sec|fan token/i;

export interface CategoryCap {
  /** CoinGecko's category id, e.g. "layer-2" — what /coins/markets?category=
   * needs. */
  id: string;
  /** CoinGecko's category name, e.g. "Layer 2 (L2)" — what a coin's own
   * /coins/{id} categories list returns, and the join key between the two. */
  name: string;
  /** Null/0 means CoinGecko has no market-cap figure for this category
   * (every "X Ecosystem" category observed live) — treated as unknown, never
   * as "narrowest," per this app's missing-≠-0 rule. */
  marketCap: number | null;
  marketCapChange24h: number | null;
}

export interface RankedCategory extends CategoryCap {
  marketCap: number;
}

/**
 * A coin's own category names, joined against the full category→market-cap
 * map, filtered to only the categories with a known positive cap and not on
 * the denylist, sorted ascending (narrowest sector first — the whole point).
 */
export function rankCategories(categoryNames: string[], capsByName: Map<string, CategoryCap>): RankedCategory[] {
  const ranked: RankedCategory[] = [];
  for (const name of categoryNames) {
    const cap = capsByName.get(name);
    if (!cap || !cap.marketCap || cap.marketCap <= 0) continue;
    if (CATEGORY_DENYLIST.test(name)) continue;
    ranked.push({ ...cap, marketCap: cap.marketCap });
  }
  return ranked.sort((a, b) => a.marketCap - b.marketCap);
}

export interface CategoryMember {
  id: string;
  symbol: string;
  imageUrl: string | null;
  price: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  marketCap: number | null;
}

export interface PeerRow extends CategoryMember {
  marketCap: number;
}

/**
 * Drops the seed itself, applies the market-cap floor, and sorts ascending
 * by 24h change — laggards (haven't moved yet) first, already-moved peers
 * still shown (never hidden — the user's own stated preference: "it can be
 * listed of course but i don't want to chase something that already
 * moved"). Members with unknown 24h change sort last, not treated as flat.
 */
export function rankPeers(members: CategoryMember[], opts: { seedId: string; mcapFloor: number }): PeerRow[] {
  return members
    .filter((m) => m.id !== opts.seedId)
    .filter((m): m is CategoryMember & { marketCap: number } => m.marketCap !== null && m.marketCap >= opts.mcapFloor)
    .sort((a, b) => {
      if (a.change24h === null && b.change24h === null) return 0;
      if (a.change24h === null) return 1;
      if (b.change24h === null) return -1;
      return a.change24h - b.change24h;
    });
}
