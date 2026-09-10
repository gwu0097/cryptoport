import "server-only";
import type { Address } from "viem";
import { fetchEvmChainsHoldings } from "./multicallEvm";
import { fetchHyperliquidHoldings } from "./hyperliquid";
import type { AdapterHolding } from "./types";

export interface EvmHoldingsResult {
  holdings: AdapterHolding[];
  /** Non-fatal partial failures (e.g. one chain's public RPC had a bad
   * moment, or Hyperliquid's API was briefly down) — the sync still saves
   * whatever it did get. Empty when everything succeeded. */
  warnings: string[];
}

/**
 * Direct on-chain reads (Multicall3 + a CoinGecko-derived token registry,
 * see multicallEvm.ts) across every chain in evmChains.ts, plus Hyperliquid
 * (spot + perps — a chain no on-chain balance read would ever see, since it
 * lives entirely inside Hyperliquid's own exchange, not a token contract).
 * No indexer dependency, no shared per-IP rate limit — an earlier version
 * of this adapter called Rabby's free API instead and rate-limited far
 * harder under real use than its own documentation suggested it would.
 *
 * Each chain (and Hyperliquid) fails independently rather than aborting the
 * whole sync — a free public RPC having a bad moment on one chain shouldn't
 * discard every other chain's correctly-read balances. Only throws if
 * literally everything failed, since a sync with zero data is worth
 * treating as a hard failure (leaves previous holdings untouched — see
 * syncWalletHoldings).
 */
export async function fetchEvmHoldings(address: string): Promise<EvmHoldingsResult> {
  const [chainsResult, hyperliquidResult] = await Promise.all([
    fetchEvmChainsHoldings(address as Address),
    fetchHyperliquidHoldings(address)
      .then((holdings) => ({ holdings, error: null as string | null }))
      .catch((e: Error) => ({ holdings: [] as AdapterHolding[], error: e.message })),
  ]);

  const holdings = [...chainsResult.holdings, ...hyperliquidResult.holdings];
  const warnings = [
    ...chainsResult.failedChains.map((f) => `${f.chainId}: ${f.error}`),
    ...(hyperliquidResult.error ? [`hyperliquid: ${hyperliquidResult.error}`] : []),
  ];

  // Nothing succeeded anywhere and something actually went wrong (as
  // opposed to a wallet that's genuinely empty, which has warnings.length
  // === 0) — treat as a hard failure so syncWalletHoldings leaves the
  // wallet's previous holdings untouched instead of overwriting them with
  // an empty set.
  if (holdings.length === 0 && warnings.length > 0) {
    throw new Error(`Every source failed: ${warnings.join("; ")}`);
  }

  return { holdings, warnings };
}
