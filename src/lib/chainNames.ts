import { EVM_CHAINS } from "./adapters/evmChains";

/** Display name for a holding's `chain` (or a wallet's `chain`, for the
 * manual/no-sub-chain fallback case) — one map covering both vocabularies
 * so the Assets page never has to know which one it's looking at. */
export const CHAIN_NAMES: Record<string, string> = {
  ...Object.fromEntries(EVM_CHAINS.map((c) => [c.id, c.name])),
  hyperliquid: "Hyperliquid",
  solana: "Solana",
  bitcoin: "Bitcoin",
  cardano: "Cardano",
  cosmoshub: "Cosmos Hub",
  injective: "Injective",
  near: "NEAR",
  sui: "Sui",
  filecoin: "Filecoin",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  ADA: "Cardano",
  ATOM: "Cosmos Hub",
  INJ: "Injective",
  NEAR: "NEAR",
  SUI: "Sui",
  FIL: "Filecoin",
};

export function chainDisplayName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? chainId;
}

/** A manual holding (chain: null) needs a fallback to group under — for one
 * of the auto-capable chains this has to be the *adapter-native* slug
 * ('bitcoin', 'eth', 'solana', 'cardano'), not the wallet's own chain field
 * as stored ('BTC', 'ETH', 'SOL', 'ADA'), even though both display
 * identically via CHAIN_NAMES above. groupByChain (queries.ts) keys groups
 * by this raw id, not the display name — falling back to the stored value
 * put a manual BTC holding into a *different* group ("BTC") than the
 * wallet's auto-synced ones ("bitcoin"), both rendered as "Bitcoin" but
 * never merged, which is exactly what produced two separate Bitcoin
 * sections for the same wallet. ETH wallets fall back to plain "eth" — a
 * manual holding added to a multi-chain EVM wallet has no way to know
 * which of its 30 configured chains it's really on.
 *
 * `chain` isn't restricted to the 4 auto-capable ones (see Wallet.chain) —
 * a manual-only chain like "RON" has no adapter-native slug to normalize
 * to, so it falls back to its own lowercased value, same as
 * chainDisplayName does for an unrecognized chainId. */
export function defaultChainId(chain: string): string {
  if (chain === "BTC") return "bitcoin";
  if (chain === "SOL") return "solana";
  if (chain === "ADA") return "cardano";
  if (chain === "ETH") return "eth";
  if (chain === "ATOM") return "cosmoshub";
  if (chain === "INJ") return "injective";
  if (chain === "NEAR") return "near";
  if (chain === "SUI") return "sui";
  if (chain === "FIL") return "filecoin";
  return chain.toLowerCase();
}
