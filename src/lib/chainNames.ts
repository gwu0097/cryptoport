import { EVM_CHAINS } from "./adapters/evmChains";
import type { Chain } from "./types";

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

/** A manual holding (chain: null) needs a fallback to group under — this
 * has to be the *adapter-native* slug ('bitcoin', 'eth', 'solana'), not the
 * wallet's own Chain enum value ('BTC', 'ETH', 'SOL'), even though both
 * display identically via CHAIN_NAMES above. groupByChain (queries.ts)
 * keys groups by this raw id, not the display name — falling back to the
 * enum value put a manual BTC holding into a *different* group ("BTC")
 * than the wallet's auto-synced ones ("bitcoin"), both rendered as
 * "Bitcoin" but never merged, which is exactly what produced two separate
 * Bitcoin sections for the same wallet. ETH wallets fall back to plain
 * "eth" — a manual holding added to a multi-chain EVM wallet has no way to
 * know which of its 30 configured chains it's really on. */
export function defaultChainId(chain: Chain): string {
  if (chain === "BTC") return "bitcoin";
  if (chain === "SOL") return "solana";
  return "eth";
}
