// Pure valuation logic: no DB, no network, no Supabase. PostgREST's
// `numeric` columns can arrive as a JS number or as a string, depending on
// PostgREST/client version — verified empirically that this project's setup
// returns numbers. This is the one place that value is parsed/validated.
// Nowhere else in the codebase should call Number() on a holding or price
// field.
//
// The rule that must never be broken: a missing price is UNPRICED, never 0
// and never the raw quantity. That silent coercion is what made the old
// spreadsheet report a $3.25M portfolio. Encoding it as a tagged union
// (rather than e.g. `value: number | null`) makes "forgot to handle
// unpriced" a type error at the call site, not a runtime surprise.

import type { HoldingSource } from "./types";

export type PostgrestNumeric = number | string | null | undefined;

export interface HoldingValuationInput {
  ticker: string;
  qty: PostgrestNumeric;
  usd_override: PostgrestNumeric;
  source: HoldingSource;
  /** The one asset this holding is priced as (docs/pricing/PLAN.md). */
  price_key?: string | null;
}

/** price_key -> the asset's one price (asset_prices.usd), or null/undefined
 * when there's no price. Keyed by asset, never by ticker. */
export type PriceMap = Record<string, PostgrestNumeric>;

export type Valuation =
  | { kind: "priced"; usd: number }
  | { kind: "unpriced"; reason: "no_usd_override" | "no_qty" | "no_price" };

export interface PortfolioTotal {
  total: number;
  unpricedCount: number;
  unpricedTickers: string[];
}

/** Parses a PostgREST numeric value (number or string form). Anything not a finite number is null. */
export function parseNumeric(value: PostgrestNumeric): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // `Number("")` is 0, not NaN — guarded so empty/whitespace strings don't
  // silently become a real value.
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One asset, one price (docs/pricing/PLAN.md): a holding with a price_key
 * is worth qty × that asset's price, everywhere. Without one (or before its
 * asset has a price), its stored value stands — a protocol position's
 * value (LP, perps, predictions), or a sync-time value until the next
 * pricing pass. Otherwise it's unpriced. Never priced by ticker: a ticker
 * can name several different coins.
 */
export function valueHolding(
  holding: HoldingValuationInput,
  prices: PriceMap,
): Valuation {
  const qty = parseNumeric(holding.qty);
  if (holding.price_key && holding.source !== "manual_usd") {
    const price = parseNumeric(prices[holding.price_key]);
    if (price !== null && qty !== null) return { kind: "priced", usd: qty * price };
  }

  const stored = parseNumeric(holding.usd_override);
  if (stored !== null) return { kind: "priced", usd: stored };

  if (holding.source === "manual_usd") return { kind: "unpriced", reason: "no_usd_override" };
  if (qty === null) return { kind: "unpriced", reason: "no_qty" };
  return { kind: "unpriced", reason: "no_price" };
}

/**
 * Sums a set of holdings. Unpriced holdings are excluded from `total` by
 * construction (there is no numeric value to add) but are counted and named
 * so the UI can say "$X across N holdings, M unpriced" instead of silently
 * dropping them.
 */
export function aggregate(
  holdings: HoldingValuationInput[],
  prices: PriceMap,
): PortfolioTotal {
  let total = 0;
  let unpricedCount = 0;
  const unpricedTickers = new Set<string>();

  for (const holding of holdings) {
    const valuation = valueHolding(holding, prices);
    if (valuation.kind === "priced") {
      total += valuation.usd;
    } else {
      unpricedCount += 1;
      unpricedTickers.add(holding.ticker);
    }
  }

  return { total, unpricedCount, unpricedTickers: [...unpricedTickers] };
}
