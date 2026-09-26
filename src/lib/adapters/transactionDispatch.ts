import "server-only";
import { EVM_CHAINS, isEvmChainId } from "./evmChains";
import { ETHERSCAN_EXPLORERS, FREE_TIER_UNSUPPORTED, fetchEvmTransactions } from "./etherscan";
import { BLOCKSCOUT_HOSTS, fetchBlockscoutTransactions } from "./blockscout";
import { ALCHEMY_HOSTS, fetchAlchemyTransactions } from "./alchemy";
import { fetchBitcoinTransactions } from "./bitcoinTx";
import { fetchSolanaTransactions } from "./solanaTx";
import { fetchCardanoTransactions, fetchCardanoTransactionsByAddress } from "./cardanoTx";
import { fetchInjectiveTransactions } from "./injectiveTx";
import { scanExtendedKey, type ScriptType } from "./bitcoinXpub";
import { isExtendedPublicKey } from "../walletDisplay";
import { mapWithConcurrency } from "./http";
import { serviceDb } from "../supabase";
import type { AdapterTransaction } from "./types";
import { txSourcesFor, type TxSource } from "../transactionSources";

/** Whether this app has *any* transaction-history source wired up for a
 * wallet's chain — BTC/SOL/ADA/INJ always do, an EVM wallet does too
 * (though only some of its actual sub-chains, see etherscan.ts), everything
 * else (ATOM, SUI, FIL, BCH, NEAR, DOT, TAO, NEO, XRP, TON, APT, ICP) does
 * not yet — ATOM specifically was researched and came up empty: the
 * generic Cosmos SDK LCD tx-search live-verified as returning zero results
 * for a real wallet with 76 known signed transactions, and no free
 * Injective-style dedicated indexer was found for Cosmos Hub (see the
 * transactions-chain-backlog memory for the fuller writeup). Used by the
 * /transactions page to show "not yet supported" instead of a Sync button
 * for a wallet on one of those chains, rather than silently offering a
 * sync that would just return nothing. */
export function hasTransactionCoverage(chain: string): boolean {
  return chain === "BTC" || chain === "SOL" || chain === "ADA" || chain === "INJ" || isEvmChainId(chain);
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
export interface WalletTransactionsResult {
  transactions: AdapterTransaction[];
  /** Every sub-chain actually queried this sync (real API calls made, real
   * answer received or empty-and-trusted) — distinct from which chains
   * happen to appear in `transactions`, which is only the chains that
   * returned at least one surviving leg. A chain the spam filter now
   * clears out entirely (e.g. a wallet whose only Base activity was spam)
   * still needs to show up here, or the caller (actions.ts) has no way to
   * know its old, now-stale rows should be deleted rather than left
   * behind forever — see that file's own doc comment for the bug this
   * fixed (real airdrop-spam rows survived a sync that had, in fact,
   * correctly filtered them out of the fresh fetch, because a plain
   * upsert only touches rows present in the new result and never deletes
   * ones that dropped out). */
  attemptedChains: string[];
  /** Chains every source failed for this sync: their saved rows are kept
   * (never erased by an error read as "no transactions"). */
  failedChains: { chain: string; error: string }[];
  /** Held chains with no transaction-history source at all. */
  unsupportedChains: string[];
}

export async function fetchWalletTransactions(
  walletId: string,
  chain: string,
  address: string,
  btcScriptType: ScriptType | null,
  cardanoStakeAddress: string | null,
): Promise<WalletTransactionsResult> {
  if (chain === "BTC") {
    const addresses = isExtendedPublicKey(address)
      ? (await scanExtendedKey(address, { cachedScriptType: btcScriptType })).addresses
      : [address];
    if (addresses.length === 0) return { transactions: [], attemptedChains: [], failedChains: [], unsupportedChains: [] };
    return { transactions: await fetchBitcoinTransactions(addresses), attemptedChains: ["bitcoin"], failedChains: [], unsupportedChains: [] };
  }

  if (chain === "SOL") {
    return { transactions: await fetchSolanaTransactions(address), attemptedChains: ["solana"], failedChains: [], unsupportedChains: [] };
  }

  if (chain === "ADA") {
    // cachedStakeAddress mirrors cardano.ts's own fetchCardanoHoldingsForSync
    // — present for the overwhelming majority of wallets (a base address's
    // stake credential is derived once, offline, and cached permanently,
    // never re-derived per sync); the rare address type with no inline
    // staking credential (pointer/enterprise) falls back to its own single
    // address, same as the balance sync does.
    const transactions = cardanoStakeAddress
      ? await fetchCardanoTransactions(cardanoStakeAddress)
      : await fetchCardanoTransactionsByAddress(address);
    return { transactions, attemptedChains: ["cardano"], failedChains: [], unsupportedChains: [] };
  }

  if (chain === "INJ") {
    return { transactions: await fetchInjectiveTransactions(address), attemptedChains: ["injective"], failedChains: [], unsupportedChains: [] };
  }

  if (isEvmChainId(chain)) {
    // The wallet itself only has the umbrella "ETH" chain — which of the
    // (up to 25) actual EVM sub-chains it's touched lives on its holdings,
    // the same lookup this app's own EVM sync already keys everything
    // else off of. Pruned to only chains it's actually held something on,
    // matching this feature's own "don't call an endpoint just to learn
    // there's nothing there" scoping — a chain fully exited (zero current
    // holdings, but real past activity) is a known, accepted gap for now.
    // No source filter — manual holdings already have chain: null (excluded
    // by the not-null check below), so this naturally also counts a chain
    // where the only activity is a DeFi position (source='auto_defi', e.g.
    // an Aave deposit on a chain with zero native balance there).
    const { data, error } = await serviceDb()
      .from("holdings")
      .select("chain")
      .eq("wallet_id", walletId)
      .not("chain", "is", null);
    if (error) throw new Error(`Failed to load wallet chains: ${error.message}`);

    const heldChains = [...new Set((data as { chain: string }[]).map((r) => r.chain))];
    // Each chain tries its sources in order (transactionSources.ts) until one
    // answers. A source failing — an Alchemy network without its Transfers
    // API, an Etherscan rate limit, a Blockscout outage — passes the chain
    // on; if none answers, the chain is reported failed and its saved rows
    // are kept. Every source used to turn its errors into [], which the sync
    // then read as "no transactions" and erased the chain's history
    // (2026-09-26). Chains run 3 at a time; Etherscan is paced app-wide
    // (etherscanFetch.ts).
    const covered = {
      alchemy: new Set(Object.keys(ALCHEMY_HOSTS)),
      etherscan: new Set(Object.keys(ETHERSCAN_EXPLORERS).filter((c) => !FREE_TIER_UNSUPPORTED.has(c))),
      blockscout: new Set(Object.keys(BLOCKSCOUT_HOSTS)),
    };
    const fetchFrom = (source: TxSource, evmChainId: string, nativeSymbol: string) =>
      source === "alchemy"
        ? fetchAlchemyTransactions(evmChainId, address, nativeSymbol)
        : source === "etherscan"
          ? fetchEvmTransactions(evmChainId, address, nativeSymbol)
          : fetchBlockscoutTransactions(evmChainId, address, nativeSymbol);
    const unsupportedChains = heldChains.filter((c) => isEvmChainId(c) && txSourcesFor(c, covered).length === 0);
    const results = await mapWithConcurrency(
      heldChains.filter((c) => txSourcesFor(c, covered).length > 0),
      3,
      async (evmChainId): Promise<{ chain: string; txs: AdapterTransaction[] } | { chain: string; error: string }> => {
        const evmChain = EVM_CHAINS.find((c) => c.id === evmChainId)!;
        const errors: string[] = [];
        for (const source of txSourcesFor(evmChainId, covered)) {
          try {
            return { chain: evmChainId, txs: await fetchFrom(source, evmChainId, evmChain.nativeSymbol) };
          } catch (e) {
            errors.push(`${source}: ${(e as Error).message}`);
          }
        }
        return { chain: evmChainId, error: errors.join(" / ") };
      },
    );
    const ok = results.filter((r): r is { chain: string; txs: AdapterTransaction[] } => "txs" in r);
    return {
      transactions: ok.flatMap((r) => r.txs),
      attemptedChains: ok.map((r) => r.chain),
      failedChains: results.filter((r): r is { chain: string; error: string } => "error" in r),
      unsupportedChains,
    };
  }

  return { transactions: [], attemptedChains: [], failedChains: [], unsupportedChains: [] }; // no free source researched/wired up for this chain yet
}
