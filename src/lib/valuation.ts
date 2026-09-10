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
}

/** ticker -> raw `usd` value from the prices table (or null/undefined if absent) */
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

export function valueHolding(
  holding: HoldingValuationInput,
  prices: PriceMap,
): Valuation {
  // A usd_override always wins, regardless of source: manual_usd rows use it
  // by definition, and an auto row can carry one too (e.g. the Hyperliquid
  // adapter pins USDC/USDT0/USDE at $1 this way — no ticker-price lookup
  // needed for a stablecoin it already knows the value of).
  const override = parseNumeric(holding.usd_override);
  if (override !== null) {
    return { kind: "priced", usd: override };
  }
  if (holding.source === "manual_usd") {
    return { kind: "unpriced", reason: "no_usd_override" };
  }

  // manual_qty | auto
  const qty = parseNumeric(holding.qty);
  if (qty === null) return { kind: "unpriced", reason: "no_qty" };

  const price = parseNumeric(prices[holding.ticker]);
  if (price === null) return { kind: "unpriced", reason: "no_price" };

  return { kind: "priced", usd: qty * price };
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
