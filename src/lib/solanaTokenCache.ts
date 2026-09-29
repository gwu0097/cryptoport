// Which of a Solana wallet's tokens to look up on Jupiter again (2026-09-29,
// Fable's review). A memecoin trader's wallet held 8,417 mints, nearly all
// dead: looking each one up (100 per call, one call per 1.1 s) took ~95 s of
// a ~300 s read, to find the 88 worth showing. What was learned about a mint
// (its name, price, liquidity) is kept in solana_token_info and re-checked
// on a schedule instead — only ever to decide what's shown; prices for
// valuation still come from the price refresh (CLAUDE.md §4.2). Pure.

export interface CachedTokenInfo {
  mint: string;
  symbol: string | null;
  icon: string | null;
  usdPrice: number | null;
  liquidity: number | null;
  checkedAt: string;
}

/** Re-checked every read: what was worth showing last time (its price and
 * the Shield check matter now). */
export const SHOWN_FLOOR_USD = 5;
/** Dust worth this much at its last price: re-checked daily (it can pump). */
export const DUST_WATCH_USD = 0.5;
export const DAILY_MS = 24 * 60 * 60_000;
export const WEEKLY_MS = 7 * DAILY_MS;

/** The mints to look up now: never seen; worth showing last time; dust
 * worth ≥ $0.50 not checked for a day; anything else not checked for a week. */
export function mintsToLookUp(held: readonly { mint: string; amount: number }[], cached: ReadonlyMap<string, CachedTokenInfo>, nowMs: number): string[] {
  return held
    .filter(({ mint, amount }) => {
      const c = cached.get(mint);
      if (!c) return true;
      const age = nowMs - Date.parse(c.checkedAt);
      const worth = c.usdPrice !== null ? c.usdPrice * amount : null;
      if (worth !== null && worth > SHOWN_FLOOR_USD) return true;
      if (worth !== null && worth >= DUST_WATCH_USD) return age >= DAILY_MS;
      return age >= WEEKLY_MS;
    })
    .map((h) => h.mint);
}
