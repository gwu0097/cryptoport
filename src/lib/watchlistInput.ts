export const MAX_BULK_TICKERS = 50;

/**
 * Splits a pasted blob of tickers (comma/newline/whitespace separated,
 * optionally $-prefixed) into a clean, deduped, uppercased list. Pure — no
 * DB/network — so it's directly unit-testable, separate from the actual
 * CoinGecko resolution step that follows it.
 *
 * Caps at MAX_BULK_TICKERS: bulk resolution is one /search call per ticker
 * (CoinGecko has no batch symbol-lookup endpoint), so this cap is what
 * keeps a paste from firing an unbounded burst of calls — a rate-limit
 * guard by construction, not a UI nicety.
 */
export function parseTickerInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const ticker = token.trim().replace(/^\$/, "").toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    result.push(ticker);
    if (result.length >= MAX_BULK_TICKERS) break;
  }
  return result;
}

export interface RankedCoin {
  symbol: string;
  marketCapRank: number | null;
}

/**
 * Picks which CoinGecko search result a bulk-add should propose for a
 * given typed ticker: prefer an exact symbol match (case-insensitive) with
 * the lowest market-cap rank (the most well-known coin with that exact
 * symbol), falling back to CoinGecko's own top/most-relevant result only
 * when nothing matches the symbol exactly, and null when there's nothing
 * to pick from at all. Never lets search-relevance alone outrank an exact
 * symbol hit — a query for "SOL" surfacing a lookalike token above Solana
 * by relevance shouldn't ever get auto-picked over the real symbol match.
 * Pure so the disambiguation logic itself (the part with real correctness
 * stakes — this is what a bulk paste silently commits to a watchlist) is
 * unit-testable without a live API call.
 */
export function pickBestMatch<T extends RankedCoin>(ticker: string, results: T[]): T | null {
  if (results.length === 0) return null;
  const upper = ticker.toUpperCase();
  const exact = results.filter((r) => r.symbol.toUpperCase() === upper);
  const pool = exact.length > 0 ? exact : results;
  return pool.reduce((best, r) => {
    if (r.marketCapRank === null) return best;
    if (best.marketCapRank === null) return r;
    return r.marketCapRank < best.marketCapRank ? r : best;
  });
}
