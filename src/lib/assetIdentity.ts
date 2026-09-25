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
import { EVM_CHAINS } from "./adapters/evmChains.ts";
import { NON_EVM_CHAINS } from "./adapters/nonEvmChains.ts";
import { NATIVE_COINGECKO_IDS } from "./adapters/coingeckoIds.ts";
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

/** Lowercased for every chain — token_registry's own convention (Solana
 * mints included, see refreshTokenRegistry), so a lookup here always
 * matches it. Keeping mints' case made 45 CoinGecko-listed Solana tokens
 * (USDC, JUP, mSOL …) miss the registry and get a second key (jup:<mint>)
 * for the same coin (2026-09-25). A `jup:` key itself keeps the real mint. */
export const contractKey = (chain: string, contract: string) => `${chain}|${contract.toLowerCase()}`;
export const venueKey = (venue: string, ticker: string) => `${venue}|${ticker.toUpperCase()}`;

// Chains whose holdings are stored under a display-only chain id.
const REGISTRY_CHAIN: Record<string, string> = { "solana-defi": "solana" };
// Native coins of venues that aren't in the chain config's native-symbol
// table (priceKey.ts only knows real chains).
export const VENUE_NATIVE: Record<string, { symbol: string; id: string }> = { hyperliquid: { symbol: "HYPE", id: "hyperliquid" } };

// A chain's second protocol coin, beside its native one (NEO's fee token).
// Safe by ticker only because the chain's adapter emits it solely for the
// canonical contract (adapters/neo.ts drops spoofed "GAS" tokens).
const PROTOCOL_COINS: Record<string, Record<string, string>> = { neo: { GAS: "gas" } };

function nativeKey(h: KeyInput): string | null {
  if (!h.chain) return null;
  const protocolCoin = PROTOCOL_COINS[h.chain]?.[h.ticker.toUpperCase()];
  if (protocolCoin) return protocolCoin;
  const venue = VENUE_NATIVE[h.chain];
  if (venue) return h.ticker.toUpperCase() === venue.symbol ? venue.id : null;
  const chain = REGISTRY_CHAIN[h.chain] ?? h.chain;
  const key = resolveCoingeckoKey({ ticker: h.ticker, source: h.source as HoldingSource, contract: null, chain });
  return key && !key.includes(":") ? key : null;
}

// Exchanges (their own balances, by ticker).
const EXCHANGES = new Set(["coinbase", "kraken", "gemini", "mexc"]);

/** A chain's native coin by its symbol (ETH -> ethereum, SOL -> solana,
 * AVAX -> avalanche-2 …), from the chain configs. On an exchange a ticker
 * that is a native coin means that coin — ahead of the ticker-matching
 * registry, which picked bridged copies for ETH (Polygon-bridged WETH) and
 * SOL (Base-bridged SOL) on 2026-09-25. A symbol claimed by two different
 * coins, or a wrapped one, is left out rather than guessed. */
export const NATIVE_BY_SYMBOL: ReadonlyMap<string, string> = (() => {
  const claims = new Map<string, Set<string>>();
  const add = (symbol: string, id: string | undefined) => {
    const sym = symbol.toUpperCase();
    if (!id || !sym || sym.startsWith("W")) return;
    claims.set(sym, (claims.get(sym) ?? new Set()).add(id));
  };
  for (const c of EVM_CHAINS) add(c.nativeSymbol, c.nativeCoingeckoId);
  for (const c of NON_EVM_CHAINS) add(c.id, NATIVE_COINGECKO_IDS[c.slug]);
  return new Map([...claims].filter(([, ids]) => ids.size === 1).map(([sym, ids]) => [sym, [...ids][0]]));
})();

/** Exchange tickers whose coin is fixed by definition: the canonical
 * stablecoins, and fiat dollars (fiat:USD, worth exactly $1 because it is
 * a dollar — not a stablecoin pin). */
export const CANONICAL_EXCHANGE: Record<string, string> = { USDC: "usd-coin", USDT: "tether", USD: "fiat:USD" };

/** The coin under a Kraken staking balance code: `SOL03.S` (SOL staked,
 * 3-day unbond), `DOT28.S`, `USDC.M`, and the legacy `ETH2` / `ETH2.S`
 * (staked ETH). Kraken's own documented naming; these aren't traded, so
 * no exchange listing maps them. Anything else is returned as is. */
export function krakenStakedBase(ticker: string): string {
  const t = ticker.toUpperCase();
  if (t === "ETH2" || t === "ETH2.S") return "ETH";
  const m = t.match(/^([A-Z]+?)(\d{2})?\.[SMFBP]$/);
  return m ? m[1] : t;
}

const SOLANA_CHAINS = new Set(["solana", "solana-defi"]);
// Venues priced by their own tickers (exchange balances; protocol accounts).
export const VENUE_CHAINS = new Set(["coinbase", "kraken", "gemini", "mexc", "hyperliquid", "polymarket"]);

/** A stored position value, not a coin quantity: its worth comes from the
 * protocol (LP, perps, prediction shares, leveraged vault) and has no single
 * coin price. Priced by its stored value. (Zerion DeFi rows are coin
 * quantities — one token in a protocol — and priced by their coin.) */
export function isPositionValue(h: KeyInput): boolean {
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

  if (h.chain && EXCHANGES.has(h.chain)) {
    const t = h.ticker.toUpperCase();
    const fixed = CANONICAL_EXCHANGE[t] ?? NATIVE_BY_SYMBOL.get(t);
    if (fixed) return fixed;
  }

  // Venues map their own tickers — checked even when a row has a contract
  // (Polymarket's PUSD carries its Polygon address).
  if (h.chain && VENUE_CHAINS.has(h.chain)) {
    const mapped = maps.venues.get(venueKey(h.chain, h.ticker));
    if (mapped) return mapped;
    // A Kraken staking balance is priced as the coin it stakes.
    if (h.chain === "kraken") {
      const base = krakenStakedBase(h.ticker);
      if (base !== h.ticker.toUpperCase()) return resolvePriceKey({ ...h, ticker: base }, maps);
    }
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
