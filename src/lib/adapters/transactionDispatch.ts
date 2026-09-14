import "server-only";
import { EVM_CHAINS, isEvmChainId } from "./evmChains";
import { ETHERSCAN_EXPLORERS, FREE_TIER_UNSUPPORTED, fetchEvmTransactions } from "./etherscan";
import { BLOCKSCOUT_HOSTS, fetchBlockscoutTransactions } from "./blockscout";
import { fetchBitcoinTransactions } from "./bitcoinTx";
import { fetchSolanaTransactions } from "./solanaTx";
import { scanExtendedKey, isExtendedPublicKey, type ScriptType } from "./bitcoinXpub";
import { mapWithConcurrency } from "./http";
import { serviceDb } from "../supabase";
import type { AdapterTransaction } from "./types";

/** Whether this app has *any* transaction-history source wired up for a
 * wallet's chain — BTC/SOL always do, an EVM wallet does too (though only
 * some of its actual sub-chains, see etherscan.ts), everything else (ADA,
 * ATOM, INJ, SUI, FIL, BCH, NEAR, DOT, TAO, NEO, XRP, TON, APT, ICP) does
 * not yet. Used by the /transactions page to show "not yet supported"
 * instead of a Sync button for a wallet on one of those chains, rather
 * than silently offering a sync that would just return nothing. */
export function hasTransactionCoverage(chain: string): boolean {
  return chain === "BTC" || chain === "SOL" || isEvmChainId(chain);
}

/**
 * Fetches a wallet's transaction history from whichever free source(s)
 * cover its chain. For EVM, that's two genuinely independent services —
 * Etherscan's unified API (13 of this app's 25 EVM chains actually free;
 * Base/Optimism/Avalanche/BSC/Gnosis are routable but paid-only, see
 * etherscan.ts) and Blockscout's per-chain hosted instances (10 more
 * chains, including 2 of Etherscan's paid-only ones — see blockscout.ts)
 * — dispatched per chain to whichever covers it, never both. A wallet on a
 * chain neither covers (every non-EVM chain except BTC/SOL, or an EVM
 * sub-chain in neither ETHERSCAN_EXPLORERS-minus-FREE_TIER_UNSUPPORTED nor
 * BLOCKSCOUT_HOSTS — currently just Avalanche, BSC, Manta) returns an
 * empty list rather than throwing — the caller shows "not yet supported"
 * for those, never a silently-empty list pretending to be complete
 * history.
 *
 * `isEvmChainId(chain)` here is the same coincidence pinnedWalletChain.ts
 * relies on: every EVM wallet's own `wallets.chain` is literally the
 * string "ETH", which happens to also be EVM_CHAINS' own Ethereum-mainnet
 * entry's id uppercased — so this one check correctly means "is this an
 * EVM-family wallet" for the wallet-level chain field, not "is this one of
 * the 25 specific sub-chain ids."
 */
export async function fetchWalletTransactions(
  walletId: string,
  chain: string,
  address: string,
  btcScriptType: ScriptType | null,
): Promise<AdapterTransaction[]> {
  if (chain === "BTC") {
    const addresses = isExtendedPublicKey(address)
      ? (await scanExtendedKey(address, { cachedScriptType: btcScriptType })).addresses
      : [address];
    if (addresses.length === 0) return [];
    return fetchBitcoinTransactions(addresses);
  }

  if (chain === "SOL") {
    return fetchSolanaTransactions(address);
  }

  if (isEvmChainId(chain)) {
    // The wallet itself only has the umbrella "ETH" chain — which of the
    // (up to 25) actual EVM sub-chains it's touched lives on its holdings,
    // the same lookup this app's own EVM sync already keys everything
    // else off of. Pruned to only chains it's actually held something on,
    // matching this feature's own "don't call an endpoint just to learn
    // there's nothing there" scoping — a chain fully exited (zero current
    // holdings, but real past activity) is a known, accepted gap for now.
    const { data, error } = await serviceDb()
      .from("holdings")
      .select("chain")
      .eq("wallet_id", walletId)
      .eq("source", "auto")
      .not("chain", "is", null);
    if (error) throw new Error(`Failed to load wallet chains: ${error.message}`);

    const heldChains = [...new Set((data as { chain: string }[]).map((r) => r.chain))];
    // Two independent free sources, dispatched to whichever actually
    // covers a given chain — Etherscan first where it's genuinely free
    // (see FREE_TIER_UNSUPPORTED), Blockscout for the chains Etherscan has
    // no coverage for at all or paywalls. No chain currently needs both
    // (the two sets don't overlap), but the `!etherscanChains.includes`
    // guard keeps it that way even if that ever changes, rather than
    // double-fetching the same chain from two sources.
    const etherscanChains = heldChains.filter((c) => c in ETHERSCAN_EXPLORERS && !FREE_TIER_UNSUPPORTED.has(c));
    const blockscoutChains = heldChains.filter((c) => c in BLOCKSCOUT_HOSTS && !etherscanChains.includes(c));

    const [etherscanResults, blockscoutResults] = await Promise.all([
      mapWithConcurrency(etherscanChains, 2, (evmChainId) => {
        const evmChain = EVM_CHAINS.find((c) => c.id === evmChainId)!;
        return fetchEvmTransactions(evmChainId, address, evmChain.nativeSymbol);
      }),
      mapWithConcurrency(blockscoutChains, 3, (evmChainId) => {
        const evmChain = EVM_CHAINS.find((c) => c.id === evmChainId)!;
        return fetchBlockscoutTransactions(evmChainId, address, evmChain.nativeSymbol);
      }),
    ]);
    return [...etherscanResults.flat(), ...blockscoutResults.flat()];
  }

  return []; // no free source researched/wired up for this chain yet
}
