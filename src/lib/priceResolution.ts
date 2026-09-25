// Pure resolution logic for prices.ts's "which tickers are safely
// CoinGecko-resolvable vs. need the slow residual fallback" split — no DB,
// no network, so this is directly unit-testable, separate from prices.ts's
// own heavy import graph (Supabase, Coinbase, Jupiter, EVM adapters), which
// pulls in things (next/headers, via supabase.ts) that can't even load
// under a plain `node --test` process. Same "pure logic gets its own
// testable file" pattern priceKey.ts already follows — resolveCoingeckoKey
// itself lives there for the identical reason.

import { resolveCoingeckoKey } from "./priceKey.ts";
import type { HoldingSource } from "./types.ts";

export interface HoldingTickerInfo {
  ticker: string;
  /** First non-null contract seen for this ticker across all holdings — a
   * ticker could in principle come from holdings with different contracts
   * (e.g. two different mints someone happened to label the same symbol);
   * this only matters for the Jupiter-fallback lookup, not for anything
   * security- or money-sensitive, so "first seen" is fine. */
  contract: string | null;
  /** Same "first non-null seen" reasoning as contract — needed to resolve
   * a CoinGecko key (contract+chain, or chain-native-symbol match). */
  chain: string | null;
  /** First row with a coingecko_id explicitly set (a manual holding added
   * via the coin picker — see priceKey.ts). Strongest possible identity
   * signal when present. */
  coingeckoId: string | null;
  /** The representative row's own source — used to skip manual_usd tickers
   * in the CoinGecko resolution step, and to gate the exchange-registry
   * fallback to auto_exchange holdings only (see
   * splitByCoingeckoResolvability's own doc comment). */
  source: string;
}

/** True when at least one holding in this ticker's group still needs a
 * ticker-keyed price — false (skip pricing this ticker entirely) only when
 * EVERY holding already has usd_override set, since per valuation.ts's own
 * rule such a holding never consults this table at all. Real, common case
 * this skips: a DeFi position already priced directly by its own protocol
 * math at sync time. */
export function tickerNeedsPricing(group: { usd_override: string | number | null }[]): boolean {
  return group.some((r) => r.usd_override === null);
}

/** The one row a ticker's group is priced through — chosen only among the
 * rows that actually need a ticker price (usd_override null). It used to
 * be picked from every row, preferring one with a contract: MORPHO held
 * on Base (priced per holding at sync) and on Coinbase (needs the ticker
 * price) picked the Base row, whose EVM contract key the CoinGecko lane
 * skips — so the Coinbase MORPHO's price stopped updating (2026-09-25).
 * Null when nothing in the group needs a ticker price. */
export function tickerInfoFor(
  ticker: string,
  group: { contract: string | null; chain: string | null; source: string; coingecko_id: string | null; usd_override: string | number | null }[],
): HoldingTickerInfo | null {
  const needing = group.filter((r) => r.usd_override === null);
  if (needing.length === 0) return null;
  const explicitIdRow = needing.find((r) => r.coingecko_id !== null);
  const nativeMatch = needing.find((r) => {
    if (r.contract !== null || r.chain === null) return false;
    const key = resolveCoingeckoKey({ ticker, source: r.source as HoldingSource, contract: null, chain: r.chain });
    return key !== null && !key.includes(":");
  });
  const contractRow = needing.find((r) => r.contract !== null);
  const fallbackRow = needing.find((r) => r.chain !== null) ?? needing[0];
  const representative = explicitIdRow ?? nativeMatch ?? contractRow ?? fallbackRow;
  return {
    ticker,
    contract: explicitIdRow || nativeMatch ? null : (contractRow?.contract ?? null),
    chain: representative.chain,
    coingeckoId: explicitIdRow?.coingecko_id ?? null,
    source: representative.source,
  };
}

export interface ResolvedTicker {
  ticker: string;
  key: string; // "<platform>:<contract>" or a bare coingecko id
}

/**
 * Splits every distinct holding ticker into: resolvable via CoinGecko (a
 * real, collision-safe key — see priceKey.ts's resolveCoingeckoKey) vs.
 * residual (no safe key at all).
 *
 * `exchangeRegistry` (ticker -> verified CoinGecko id, see
 * exchangeAssetRegistry.ts) is a second, separate resolution source,
 * deliberately gated to `source === "auto_exchange"` only. That
 * restriction is the load-bearing safety property: the registry's trust
 * justification is that a connected exchange's own listing/compliance
 * process already verified what a ticker means, which only holds for a
 * holding that actually came from that exchange. A DeFi-position or
 * manual holding sharing a symbol with something an exchange lists must
 * still fall to residual, never get silently matched this way.
 */
export function splitByCoingeckoResolvability(
  tickers: HoldingTickerInfo[],
  exchangeRegistry: Map<string, string>,
): {
  resolved: ResolvedTicker[];
  residual: HoldingTickerInfo[];
} {
  const resolved: ResolvedTicker[] = [];
  const residual: HoldingTickerInfo[] = [];
  for (const t of tickers) {
    if (t.source === "manual_usd") {
      residual.push(t);
      continue;
    }
    const key = resolveCoingeckoKey({
      ticker: t.ticker,
      source: t.source as HoldingSource,
      contract: t.contract,
      chain: t.chain,
      coingeckoId: t.coingeckoId,
    });
    if (key) {
      resolved.push({ ticker: t.ticker, key });
      continue;
    }
    if (t.source === "auto_exchange") {
      const registryId = exchangeRegistry.get(t.ticker.toUpperCase());
      if (registryId) {
        resolved.push({ ticker: t.ticker, key: registryId });
        continue;
      }
    }
    residual.push(t);
  }
  return { resolved, residual };
}
