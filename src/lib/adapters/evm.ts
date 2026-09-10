import "server-only";
import type { Address } from "viem";
import { fetchEvmChainsHoldings } from "./multicallEvm";
import { fetchHyperliquidHoldings } from "./hyperliquid";
import type { AdapterHolding } from "./types";

/**
 * Direct on-chain reads (Multicall3 + a CoinGecko-derived token registry,
 * see multicallEvm.ts) across every chain in evmChains.ts, plus Hyperliquid
 * (spot + perps — a chain no on-chain balance read would ever see, since it
 * lives entirely inside Hyperliquid's own exchange, not a token contract).
 * No indexer dependency, no shared per-IP rate limit — an earlier version
 * of this adapter called Rabby's free API instead and rate-limited far
 * harder under real use than its own documentation suggested it would.
 */
export async function fetchEvmHoldings(address: string): Promise<AdapterHolding[]> {
  const [chains, hyperliquid] = await Promise.all([
    fetchEvmChainsHoldings(address as Address),
    fetchHyperliquidHoldings(address),
  ]);
  return [...chains, ...hyperliquid];
}
