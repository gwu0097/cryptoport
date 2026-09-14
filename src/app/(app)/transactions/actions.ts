"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { userDb } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { fetchWalletTransactions } from "@/lib/adapters/transactionDispatch";
import type { ScriptType } from "@/lib/adapters/bitcoinXpub";

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
 */
export async function syncWalletTransactions(walletId: string) {
  await requireUser();
  const db = await userDb();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("id, chain, address, btc_script_type")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet.address) throw new Error("This wallet has no address set.");

  const { error: markError } = await db.from("wallets").update({ tx_sync_status: "syncing" }).eq("id", walletId);
  if (markError) throw new Error(`Failed to start transaction sync: ${markError.message}`);

  after(async () => {
    // Fresh client inside after(), not the outer `db` — same documented
    // reasoning as syncWalletHoldings.
    const afterDb = await userDb();
    try {
      const transactions = await fetchWalletTransactions(
        walletId,
        wallet.chain,
        wallet.address!,
        wallet.btc_script_type as ScriptType | null,
      );

      const rows = [...transactions]
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, MAX_STORED_PER_WALLET);

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
}

/** Same shape as wallets/actions.ts's syncAllWallets — kicks off every
 * active wallet's transaction sync as its own background task, skipping
 * any already mid-sync, and itself returns fast since each individual
 * call's real work happens in its own after(). */
export async function syncAllWalletTransactions() {
  await requireUser();
  const db = await userDb();
  const { data: wallets, error } = await db.from("wallets").select("id, tx_sync_status").eq("active", true);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);

  for (const wallet of wallets as { id: string; tx_sync_status: string | null }[]) {
    if (wallet.tx_sync_status === "syncing") continue;
    await syncWalletTransactions(wallet.id);
  }
}
