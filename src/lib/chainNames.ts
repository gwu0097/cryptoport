import { EVM_CHAINS } from "./adapters/evmChains";

/** Display name for a holding's `chain` (or a wallet's `chain`, for the
 * manual/no-sub-chain fallback case) — one map covering both vocabularies
 * so the Assets page never has to know which one it's looking at. */
export const CHAIN_NAMES: Record<string, string> = {
  ...Object.fromEntries(EVM_CHAINS.map((c) => [c.id, c.name])),
  hyperliquid: "Hyperliquid",
  solana: "Solana",
  bitcoin: "Bitcoin",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
};

export function chainDisplayName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? chainId;
}
