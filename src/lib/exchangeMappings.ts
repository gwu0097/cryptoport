// How each exchange/venue ticker you hold got the coin it's priced as — for
// the Settings "Exchange coin mappings" review. Pure (no DB): the same order
// resolvePriceKey (assetIdentity.ts) applies, read back from the stored key.

import { CANONICAL_EXCHANGE, NATIVE_BY_SYMBOL, VENUE_NATIVE } from "./assetIdentity.ts";

export type MatchKind =
  | "canonical" // USDC / USDT / USD: fixed by definition
  | "native" // a chain's own coin (ETH, SOL …)
  | "venue-list" // the venue's own listing (Coinbase's catalog) or a hand-set mapping
  | "copied" // copied from Coinbase's list for another exchange: needs review
  | "venue-price" // no CoinGecko coin; priced by the venue itself (coinbase:, hl:)
  | "override" // keyed with no mapping row behind it (a hand-set override)
  | "unpriced"; // no mapping: shown as "—"

export interface MappingInput {
  venue: string;
  ticker: string;
  price_key: string | null;
}

/** exchange_assets.mapping_source per `${venue}|${TICKER}`. */
export type MappingSources = ReadonlyMap<string, string>;

export function classifyMapping(h: MappingInput, sources: MappingSources): MatchKind {
  if (!h.price_key) return "unpriced";
  const t = h.ticker.toUpperCase();
  if (CANONICAL_EXCHANGE[t] === h.price_key) return "canonical";
  if (NATIVE_BY_SYMBOL.get(t) === h.price_key || VENUE_NATIVE[h.venue]?.id === h.price_key) return "native";
  if (h.price_key.startsWith("coinbase:") || h.price_key.startsWith("hl:")) return "venue-price";
  const source = sources.get(`${h.venue}|${t}`);
  if (source === "coinbase-catalog") return "copied";
  return source ? "venue-list" : "override";
}

export const MATCH_LABEL: Record<MatchKind, string> = {
  canonical: "Stablecoin / cash",
  native: "Native coin",
  "venue-list": "Exchange's own list",
  copied: "Copied from Coinbase — review",
  "venue-price": "Exchange's own price",
  override: "Set by hand",
  unpriced: "No match — unpriced",
};
