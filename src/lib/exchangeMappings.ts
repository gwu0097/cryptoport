// How each exchange/venue ticker you hold got the coin it's priced as — for
// the Settings "Exchange coin mappings" review. Pure (no DB): the same order
// resolvePriceKey (assetIdentity.ts) applies, read back from the stored key.

import { CANONICAL_EXCHANGE, NATIVE_BY_SYMBOL, VENUE_NATIVE, krakenStakedBase } from "./assetIdentity.ts";

export type MatchKind =
  | "canonical" // USDC / USDT / USD: fixed by definition
  | "native" // a chain's own coin (ETH, SOL …)
  | "venue-list" // the venue's own listing (Coinbase's catalog)
  | "exchange-data" // CoinGecko's data for that exchange (which coin each pair trades)
  | "staked" // a Kraken staking balance, priced as the coin it stakes
  | "copied" // copied from Coinbase's list for another exchange: needs review
  | "venue-price" // no CoinGecko coin; priced by the venue itself (coinbase:, hl:)
  | "override" // a hand-added row (a stopgap), or keyed with no row behind it
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
  if (!source && h.venue === "kraken" && krakenStakedBase(t) !== t) return "staked";
  if (source === "coinbase-catalog") return "copied";
  if (source === "coingecko-exchange") return "exchange-data";
  // A hand-added row is a stopgap for a gap the automatic sources missed —
  // shown as such, never as the exchange's own data.
  if (source === "manual" || !source) return "override";
  return "venue-list";
}

export const MATCH_LABEL: Record<MatchKind, string> = {
  canonical: "Stablecoin / cash",
  native: "Native coin",
  "venue-list": "Exchange's own list",
  "exchange-data": "CoinGecko's exchange data",
  staked: "Staked — priced as its coin",
  copied: "Copied from Coinbase — review",
  "venue-price": "Exchange's own price",
  override: "Set by hand (stopgap)",
  unpriced: "No match — unpriced",
};
