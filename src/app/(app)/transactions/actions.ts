"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { userDb } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { fetchWalletTransactions } from "@/lib/adapters/transactionDispatch";
import type { ScriptType } from "@/lib/adapters/bitcoinXpub";
import { JOB_STALE_MS, type JobStartResult } from "@/lib/jobStatus";

// Not unbounded — each adapter already caps its own per-call fetch (see
// etherscan.ts/bitcoinShared.ts/solanaTx.ts), and the merged result across
// every source for one wallet is capped again here before it's stored.
const MAX_STORED_PER_WALLET = 200;

/**
 * Same after() pattern as syncWalletHoldings (wallets/actions.ts) and for
 * the same reason — transaction fetching (up to 18 EVM chains' worth of
 * calls for a multi-chain wallet, or a full xpub address-by-address scan
 * for BTC) can take real time, and an awaited Server Action would freeze
 * every other click app-wide until it finished (see CLAUDE.md's Loading
 * feedback section). Deliberately its own action, not folded into
 * syncWalletHoldings — a slower, separate concern shouldn't make the
 * existing balance sync any slower than it already is.
 *
 * Same compare-and-set claim as syncWalletHoldings, on its own
 * tx_sync_status/tx_sync_started_at pair rather than reusing the holdings
 * sync's columns — these are genuinely different jobs that can each be
 * mid-run independently, so they need independent claims. Returns
 * JobStartResult (lib/jobStatus.ts) instead of throwing on "already
 * syncing", same reasoning as syncWalletHoldings.
 */
export async function syncWalletTransactions(walletId: string): Promise<JobStartResult> {
  await requireUser();
  const db = await userDb();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("id, chain, address, btc_script_type")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet.address) throw new Error("This wallet has no address set.");

  const syncStartedAt = Date.now();
  const staleBefore = new Date(syncStartedAt - JOB_STALE_MS).toISOString();
  const { data: claimed, error: markError } = await db
    .from("wallets")
    .update({ tx_sync_status: "syncing", tx_sync_started_at: new Date(syncStartedAt).toISOString() })
    .eq("id", walletId)
    .or(`tx_sync_status.neq.syncing,tx_sync_status.is.null,tx_sync_started_at.lt.${staleBefore}`)
    .select("id");
  if (markError) throw new Error(`Failed to start transaction sync: ${markError.message}`);
  if (!claimed || claimed.length === 0) {
    return { started: false, reason: "A transaction sync is already running for this wallet." };
  }

  after(async () => {
    // Fresh client inside after(), not the outer `db` — same documented
    // reasoning as syncWalletHoldings.
    const afterDb = await userDb();
    try {
      const { transactions, attemptedChains } = await fetchWalletTransactions(
        walletId,
        wallet.chain,
        wallet.address!,
        wallet.btc_script_type as ScriptType | null,
      );

      const rows = [...transactions]
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, MAX_STORED_PER_WALLET);

      // A plain upsert only ever touches rows present in the fresh fetch —
      // it can't remove one that dropped out (a spam token the filter now
      // correctly excludes, a transaction that fell outside this sync's
      // cap window). Real bug, caught live: a wallet's spam-token rows
      // survived a sync that had, in fact, filtered them out of the fetch,
      // because nothing ever deleted the old ones. Clearing every row for
      // exactly the chains this sync actually queried — never a chain that
      // wasn't attempted this time — before inserting the fresh set is
      // what makes this a real replace instead of an ever-growing
      // accumulation of everything ever seen.
      if (attemptedChains.length > 0) {
        const { error: deleteError } = await afterDb
          .from("transactions")
          .delete()
          .eq("wallet_id", walletId)
          .in("chain", attemptedChains);
        if (deleteError) throw new Error(`Failed to clear stale transactions: ${deleteError.message}`);
      }

      // `leg` is assigned here (not by each adapter) — the shared "more
      // than one asset moved in the same transaction" numbering scheme
      // documented on the transactions table itself, computed once across
      // whatever every source returned rather than each adapter needing
      // to know about every other adapter's own output.
      const legCounts = new Map<string, number>();
      const dbRows = rows.map((t) => {
        const key = `${t.chain}:${t.txHash}`;
        const leg = legCounts.get(key) ?? 0;
        legCounts.set(key, leg + 1);
        return {
          wallet_id: walletId,
          chain: t.chain,
          tx_hash: t.txHash,
          leg,
          occurred_at: t.occurredAt,
          direction: t.direction,
          ticker: t.ticker,
          amount: t.amount,
          counterparty: t.counterparty,
          explorer_url: t.explorerUrl,
          fee: t.fee,
        };
      });

      if (dbRows.length > 0) {
        const { error } = await afterDb
          .from("transactions")
          .upsert(dbRows, { onConflict: "wallet_id,chain,tx_hash,leg" });
        if (error) throw new Error(`Failed to save transactions: ${error.message}`);
      }

      await afterDb
        .from("wallets")
        .update({ tx_synced_at: new Date().toISOString(), tx_sync_status: `ok (${dbRows.length})` })
        .eq("id", walletId);
    } catch (e) {
      await afterDb
        .from("wallets")
        .update({ tx_sync_status: `error: ${(e as Error).message}` })
        .eq("id", walletId);
    } finally {
      revalidatePath("/transactions");
    }
  });

  revalidatePath("/transactions");
  return { started: true };
}

/** Same shape as wallets/actions.ts's syncAllWallets — kicks off every
 * active wallet's transaction sync as its own background task and itself
 * returns fast since each individual call's real work happens in its own
 * after(). Parallel (Promise.all), not a sequential loop — a sequential
 * version of this exact pattern in syncAllWallets was live-reported as
 * leaving its button stuck on an in-flight state for 8+ seconds with more
 * than a couple of wallets; each wallet's own CAS claim decides whether
 * it actually starts, same as a single "Sync this wallet" click. */
export async function syncAllWalletTransactions(): Promise<JobStartResult> {
  await requireUser();
  const db = await userDb();
  const { data: wallets, error } = await db.from("wallets").select("id").eq("active", true);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);
  if (wallets.length === 0) return { started: false, reason: "No wallets to sync." };

  const results = await Promise.all(wallets.map((wallet) => syncWalletTransactions(wallet.id)));
  const claimedCount = results.filter((r) => r.started).length;
  if (claimedCount === 0) return { started: false, reason: "All wallets are already syncing." };
  return { started: true };
}
