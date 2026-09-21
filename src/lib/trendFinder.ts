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

const STOPWORDS = new Set(["the", "and", "for", "with"]);

/** Lowercases, strips a trailing "(ABBR)" parenthetical, splits on
 * non-alphanumeric, drops short/stopword tokens — the normalized token set
 * matchCategoryName compares. Exported for its own unit tests only. */
export function normalizeCategoryTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Above this fraction of shared tokens (intersection / larger token-set
 * size — penalizes both an over-broad guess and an over-narrow category),
 * a match is confident enough to show; below it, "no matching category
 * found" is the honest answer. 0.5 was picked by hand-testing against a
 * real trap in CoinGecko's own taxonomy: two dozen near-duplicate
 * "Tokenized X" categories that a naive keyword search would all match
 * equally against a generic "tokenization" guess — this threshold, plus
 * scoring against ALL categories rather than just the first keyword hit,
 * lets an exact/near-exact name win outright over a same-family partial
 * match like "Tokenized Uranium". */
const MIN_CATEGORY_MATCH_SCORE = 0.5;

export interface CategoryNameStat {
  id: string;
  name: string;
}

/**
 * Matches the AI's own free-text category guess (see adapters/
 * perplexity.ts's TrendExplanation.categoryGuess) against the real
 * CoinGecko category name list — the AI's guess is never trusted directly
 * as a real category id, since it's free text and CoinGecko's taxonomy is
 * fragmented enough that a plausible-sounding guess might not correspond
 * to anything real, or might be a near-miss of several similar real names.
 */
export function matchCategoryName<T extends CategoryNameStat>(guess: string, categories: T[]): T | null {
  const guessTokens = normalizeCategoryTokens(guess);
  if (guessTokens.size === 0) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const category of categories) {
    const categoryTokens = normalizeCategoryTokens(category.name);
    if (categoryTokens.size === 0) continue;
    let shared = 0;
    for (const t of guessTokens) if (categoryTokens.has(t)) shared++;
    const score = shared / Math.max(guessTokens.size, categoryTokens.size);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return bestScore >= MIN_CATEGORY_MATCH_SCORE ? best : null;
}
