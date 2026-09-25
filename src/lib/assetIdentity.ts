// Which one asset a holding is priced as — its `price_key` (docs/pricing/
// PLAN.md). One rule set for every sync path and the backfill, so a holding
// can't get two different identities from two code paths. Pure (no DB, no
// network): the lookup tables are passed in (adapters/assetKeys.ts loads
// them).
//
// A key is a CoinGecko coin id whenever one exists; namespaced keys only for
// the long tail CoinGecko doesn't list: `jup:<mint>` (Solana, priced per
// mint), `hl:<TOKEN>` (Hyperliquid spot), `coinbase:<TICKER>` (Coinbase-held,
// no id). Never a ticker match: no mapping means no key, and the holding is
// unpriced ("—").

import { resolveCoingeckoKey } from "./priceKey.ts";
import type { HoldingSource } from "./types.ts";

export interface KeyInput {
  ticker: string;
  chain: string | null;
  contract: string | null;
  source: string;
  category?: string | null;
  coingecko_id?: string | null;
  protocol_section?: string | null;
}

export interface KeyMaps {
  /** token_registry: `${chain}|${contract lowercase}` -> CoinGecko id
   * (CoinGecko's own contract -> coin map). */
  registry: ReadonlyMap<string, string>;
  /** asset_contracts: `${chain}|${contract lowercase or 'native'}` -> key;
   * wins over everything (natives not covered by chain config, manual fixes). */
  overrides: ReadonlyMap<string, string>;
  /** exchange_assets: `${venue}|${TICKER}` -> key (Coinbase, Kraken, Gemini,
   * Hyperliquid, Polymarket …). */
  venues: ReadonlyMap<string, string>;
}

/** EVM addresses are case-insensitive (lowercased); Solana mints, Sui types
 * and Cosmos denoms are case-sensitive (kept as-is). */
export const contractKey = (chain: string, contract: string) =>
  `${chain}|${/^0x[0-9a-f]+$/i.test(contract) ? contract.toLowerCase() : contract}`;
export const venueKey = (venue: string, ticker: string) => `${venue}|${ticker.toUpperCase()}`;

// Chains whose holdings are stored under a display-only chain id.
const REGISTRY_CHAIN: Record<string, string> = { "solana-defi": "solana" };
// Native coins of venues that aren't in the chain config's native-symbol
// table (priceKey.ts only knows real chains).
const VENUE_NATIVE: Record<string, { symbol: string; id: string }> = { hyperliquid: { symbol: "HYPE", id: "hyperliquid" } };

function nativeKey(h: KeyInput): string | null {
  if (!h.chain) return null;
  const venue = VENUE_NATIVE[h.chain];
  if (venue) return h.ticker.toUpperCase() === venue.symbol ? venue.id : null;
  const chain = REGISTRY_CHAIN[h.chain] ?? h.chain;
  const key = resolveCoingeckoKey({ ticker: h.ticker, source: h.source as HoldingSource, contract: null, chain });
  return key && !key.includes(":") ? key : null;
}

const SOLANA_CHAINS = new Set(["solana", "solana-defi"]);
// Venues priced by their own tickers (exchange balances; protocol accounts).
const VENUE_CHAINS = new Set(["coinbase", "kraken", "gemini", "mexc", "hyperliquid", "polymarket"]);

/** A stored position value, not a coin quantity: its worth comes from the
 * protocol (LP, perps, prediction shares, leveraged vault, a Zerion
 * position) and has no single coin price. Priced by its stored value. */
export function isPositionValue(h: KeyInput): boolean {
  if (h.source === "auto_defi") return true; // Zerion positions: protocol-valued
  const ticker = h.ticker.toUpperCase();
  if (ticker.endsWith("-PERP") || ticker.endsWith("-LP") || ticker.startsWith("KAMINO-")) return true;
  if (h.chain === "hyperliquid" && (h.protocol_section === "Perpetuals" || h.protocol_section === "Yield")) return true;
  if (h.chain === "polymarket" && h.protocol_section !== "Deposit") return true; // prediction shares
  return false;
}

export function resolvePriceKey(h: KeyInput, maps: KeyMaps): string | null {
  if (h.source === "manual_usd" || isPositionValue(h)) return null;

  if (h.chain) {
    const override = maps.overrides.get(contractKey(h.chain, h.contract ?? "native"));
    if (override) return override;
  }

  // Rows that already carry the coin they are (Cosmos registry, manual pick).
  if (h.source === "auto_cosmos" || h.source === "manual_qty") return h.coingecko_id ?? null;

  if (h.chain && VENUE_CHAINS.has(h.chain) && !h.contract) {
    const mapped = maps.venues.get(venueKey(h.chain, h.ticker));
    if (mapped) return mapped;
    if (h.chain === "coinbase") return `coinbase:${h.ticker.toUpperCase()}`;
    if (h.chain === "hyperliquid") return nativeKey(h) ?? `hl:${h.ticker.toUpperCase()}`;
    return null; // an exchange ticker with no mapping: unpriced, never guessed
  }

  if (h.contract && h.chain) {
    const id = maps.registry.get(contractKey(REGISTRY_CHAIN[h.chain] ?? h.chain, h.contract));
    if (id) return id;
    if (SOLANA_CHAINS.has(h.chain)) return `jup:${h.contract}`;
    return null;
  }

  // A chain's own native coin (only when the ticker is that native symbol).
  return nativeKey(h);
}
