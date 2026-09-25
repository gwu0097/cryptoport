// Why a holding has no price — the admin coverage report (/admin/pricing).
// Every coin holding across every user's active wallets gets one cause, so a
// new user's gaps show up here without anyone reporting them. Pure (no DB).

import { isPositionValue, VENUE_CHAINS, type KeyInput } from "./assetIdentity.ts";

export type GapCause =
  | "exchange-ticker" // an exchange/venue ticker with no mapping
  | "cosmos-ibc" // a Cosmos token by bridge denom (ibc/…, factory/…)
  | "cosmos-token" // a Cosmos token by name, with no coin in the chain registry
  | "unlisted-contract" // a token contract CoinGecko doesn't list
  | "unmatched-native" // no contract and not a chain's own coin
  | "no-coin-picked" // a hand-entered quantity with no coin
  | "not-priced-yet" // has a coin, never priced (next refresh prices it)
  | "source-dropped"; // has a coin, its source returns no price

export const GAP_LABEL: Record<GapCause, string> = {
  "exchange-ticker": "Exchange ticker, no mapping",
  "cosmos-ibc": "Cosmos bridged token (ibc/…)",
  "cosmos-token": "Cosmos token, no coin in registry",
  "unlisted-contract": "Token not listed on CoinGecko",
  "unmatched-native": "No contract, not a native coin",
  "no-coin-picked": "Manual quantity, no coin picked",
  "not-priced-yet": "Coin known, not priced yet",
  "source-dropped": "Coin known, source has no price",
};

export interface CoverageHolding extends KeyInput {
  price_key: string | null;
}

export interface KeyPriceState {
  usd: number | null;
  missing_since: string | null;
}

/** Whether a holding counts at all: positions are valued by their protocol
 * and hand-entered dollar values have no coin, so neither is a gap. */
export function isCoinHolding(h: CoverageHolding): boolean {
  return h.source !== "manual_usd" && !isPositionValue(h);
}

/** Why this coin holding has no price, or null when it's priced. */
export function gapCause(h: CoverageHolding, prices: ReadonlyMap<string, KeyPriceState>): GapCause | null {
  if (h.price_key) {
    const p = prices.get(h.price_key);
    if (p && p.usd !== null) return null;
    return p?.missing_since ? "source-dropped" : "not-priced-yet";
  }
  if (h.source === "manual_qty") return "no-coin-picked";
  if (h.chain && VENUE_CHAINS.has(h.chain)) return "exchange-ticker";
  if (h.source === "auto_cosmos") {
    const denom = `${h.contract ?? ""} ${h.ticker}`.toLowerCase();
    return denom.includes("ibc/") || denom.includes("factory/") ? "cosmos-ibc" : "cosmos-token";
  }
  return h.contract ? "unlisted-contract" : "unmatched-native";
}
