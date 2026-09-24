import "server-only";
import { getLendingPositions } from "@naviprotocol/lending";
import { naviPositionsToHoldings, type NaviHolding, type NaviPositionLike } from "../naviPositions";

// Navi lending positions for a Sui address, via Navi's own SDK
// (@naviprotocol/lending: reads the protocol's on-chain state over Sui RPC —
// free, no key). Zerion doesn't index Sui (its chain list has no "sui"), and
// the one Sui aggregator that does (BlockVision's DeFi portfolio API) is
// Pro-only. Mapping and valuation rules: ../naviPositions.ts.

const TIMEOUT_MS = 20_000; // live: ~7s; never let it hold the sync hostage

export async function fetchNaviHoldings(address: string): Promise<{ holdings: NaviHolding[]; warnings: string[] }> {
  const positions = (await Promise.race([
    getLendingPositions(address),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
  ])) as unknown as NaviPositionLike[];
  const { holdings, unpriced } = naviPositionsToHoldings(positions);
  return {
    holdings,
    warnings: unpriced.length ? [`Navi: no price for ${unpriced.join(", ")} (left out of the total)`] : [],
  };
}
