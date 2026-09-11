import { EVM_CHAINS } from "./adapters/evmChains.ts";
import { NON_EVM_CHAINS, findNonEvmChain } from "./adapters/nonEvmChains.ts";

/** Display name for a holding's `chain` (or a wallet's `chain`, for the
 * manual/no-sub-chain fallback case) — one map covering both vocabularies
 * (a wallet's own uppercase chain field, e.g. "SOL", and the adapter-native
 * lowercase slug a holding's own `chain` column uses, e.g. "solana") so the
 * Assets page never has to know which one it's looking at. Derived from
 * nonEvmChains.ts's single chain list rather than hand-listing both
 * vocabularies here — see that file's header for why this used to drift. */
export const CHAIN_NAMES: Record<string, string> = {
  ...Object.fromEntries(EVM_CHAINS.map((c) => [c.id, c.name])),
  ...Object.fromEntries(NON_EVM_CHAINS.flatMap((c) => [[c.id, c.displayName] as const, [c.slug, c.displayName] as const])),
  ETH: "Ethereum",
  hyperliquid: "Hyperliquid",
  "solana-defi": "Solana DeFi",
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
 * sections for the same wallet.
 *
 * Looks up nonEvmChains.ts's single chain list for the slug (see that
 * file's header — this used to be its own hand-written if-ladder, with no
 * case at all for NEO or TON; those "worked" only because their uppercase
 * ticker happens to coincidentally lowercase into their real chain id,
 * unlike XRP, which needed its own explicit case for exactly this reason).
 * Anything not in that list — every EVM chain (falls through correctly:
 * "ETH".toLowerCase() === "eth", and any other EVM label like "RON"
 * likewise lowercases to its own real chain id) and any manual-only chain
 * with no adapter (e.g. "RON" used as a plain label, not for auto-sync) —
 * falls back to its own lowercased value, same as chainDisplayName does
 * for an unrecognized chainId. */
export function defaultChainId(chain: string): string {
  return findNonEvmChain(chain)?.slug ?? chain.toLowerCase();
}
