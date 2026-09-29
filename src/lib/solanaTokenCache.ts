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
  /** Jupiter Shield's verdict (a critical warning: not sellable) and when;
   * null until checked. */
  unsellable?: boolean | null;
  shieldCheckedAt?: string | null;
}

/** Re-checked every read: what was shown last time — worth over $5 with
 * $100k liquidity (jupiter.ts's show rule; its price and the Shield check
 * matter now). */
export const SHOWN_FLOOR_USD = 5;
export const SHOW_LIQUIDITY = 100_000;
/** Dust worth this much with a real market: re-checked daily (it can pump).
 * Thousands of dead coins keep a nominal price on a tiny pool — those wait
 * a week (2026-09-29: 65 lookups a read were such coins). */
export const DUST_WATCH_USD = 0.5;
export const MARKET_LIQUIDITY = 10_000;
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
      const liquidity = c.liquidity ?? 0;
      if (worth !== null && worth > SHOWN_FLOOR_USD && liquidity >= SHOW_LIQUIDITY) return true;
      if (worth !== null && worth >= DUST_WATCH_USD && liquidity >= MARKET_LIQUIDITY) return age >= DAILY_MS;
      return age >= WEEKLY_MS;
    })
    .map((h) => h.mint);
}

/** The show candidates to ask Shield about now: a priced one (a real
 * holding — it can turn unsellable) every read; a named but unpriced one
 * (a memecoin wallet's thousands of dead coins: 158 Shield calls, 170 s a
 * read on 2026-09-29) when never checked or checked over a week ago. */
export function mintsToShieldCheck(candidates: readonly { mint: string; priced: boolean }[], cached: ReadonlyMap<string, CachedTokenInfo>, nowMs: number): string[] {
  return candidates
    .filter(({ mint, priced }) => {
      if (priced) return true;
      const at = cached.get(mint)?.shieldCheckedAt;
      return !at || nowMs - Date.parse(at) >= WEEKLY_MS;
    })
    .map((c) => c.mint);
}
