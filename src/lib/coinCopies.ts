// The Assets page's combine view, copies side (owner 2026-10-08: "it should
// also combine USDC", then 16 WETH rows): every copy of one coin — the same
// token native on another chain, or a bridged copy (USDC.e, USDbC, axlUSDC,
// Wormhole's USDCet, USDT0) — folded into one row. CoinGecko lists most such
// copies as coins of their own (a $412K-cap "USDC" beside the $73B one, a
// WETH per chain), so without this one coin shows as a dozen rows. Pure.
//
// Display only, like liquid staking (liquidStaking.ts): each holding keeps its
// own price and valuation (CLAUDE.md §4.2 — bridged copies are their own
// assets), so totals are the same with the toggle on or off. Two rows are
// copies when
//  - they have the same ticker (case and punctuation ignored) and prices
//    within SAME_TICKER_BAND of each other — two different coins sharing a
//    ticker are never at the same price, so the price is the check; or
//  - one is a renamed stablecoin copy in BRIDGED (USDC.e → USDC) priced
//    within PEG_BAND of $1.
// An unpriced row never joins.

import type { AssetGroup } from "./queries.ts";

/** Same-ticker rows join when their prices are this close (relative). */
export const SAME_TICKER_BAND = 0.01;
/** A renamed stablecoin copy joins when within this of $1. */
export const PEG_BAND = 0.02;
/** Renamed copies (normalized ticker) → the ticker they're a copy of. */
const BRIDGED: Record<string, string> = { USDCE: "USDC", USDBC: "USDC", USDCET: "USDC", AXLUSDC: "USDC", USDTE: "USDT", USDT0: "USDT", AXLUSDT: "USDT" };
/** The row a family folds into when held: the canonical coin. */
const CANONICAL: Record<string, string> = { USDC: "usd-coin", USDT: "tether", WETH: "weth" };

const norm = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** tickerKey of each copy → tickerKey of the row it joins: the canonical
 * coin's when held, else the family's largest row. Rows `taken` by liquid
 * staking are left alone. */
export function resolveCoinCopies(groups: readonly AssetGroup[], taken: ReadonlySet<string> = new Set()): Map<string, string> {
  const families = new Map<string, AssetGroup[]>();
  for (const g of groups) {
    if (taken.has(g.tickerKey) || g.price === null || g.price <= 0) continue;
    const t = norm(g.ticker);
    const renamed = BRIDGED[t];
    if (renamed && Math.abs(g.price - 1) > PEG_BAND) continue;
    const family = renamed ?? t;
    families.set(family, [...(families.get(family) ?? []), g]);
  }
  const out = new Map<string, string>();
  for (const [family, rows] of families) {
    if (rows.length < 2) continue;
    const base = rows.find((g) => g.tickerKey === CANONICAL[family]) ?? [...rows].sort((a, b) => b.total - a.total)[0];
    for (const g of rows) {
      if (g === base) continue;
      const renamed = !!BRIDGED[norm(g.ticker)];
      // A same-ticker row must be priced like the base; a renamed stablecoin
      // copy was checked against $1 above.
      if (!renamed && Math.abs(g.price! - base.price!) > SAME_TICKER_BAND * base.price!) continue;
      out.set(g.tickerKey, base.tickerKey);
    }
  }
  return out;
}
