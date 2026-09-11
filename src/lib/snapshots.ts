import "server-only";
import { serviceDb } from "./supabase";
import { aggregate } from "./valuation";
import { getPriceMap } from "./queries";
import type { Holding } from "./types";

/**
 * Captures one row per user into cryptoport.portfolio_snapshots, and one
 * row per wallet into cryptoport.wallet_snapshots — the Dashboard's
 * value-history chart and Analytics' per-wallet breakdown are both built
 * entirely from these, and this is the only writer (see the cron route
 * this is called from). Runs across every active wallet for every user in
 * one pass via serviceDb() (no session, so no per-user userDb() call is
 * possible here) rather than looping a per-user query — one shared
 * getPriceMap() read, same primitives (aggregate from valuation.ts) the
 * live "Total value" panel uses, so a snapshot always agrees with what the
 * app showed that day. The wallet rows are built from the exact same
 * holdings list as the user rows, so a wallet's total and the user total
 * it rolls into can never disagree.
 */
export async function capturePortfolioSnapshots(): Promise<{ users: number; wallets: number }> {
  const [{ data: wallets, error }, prices] = await Promise.all([
    serviceDb().from("wallets").select("id, user_id, holdings(*)").eq("active", true),
    getPriceMap(),
  ]);
  if (error) throw new Error(`Failed to load wallets for snapshot: ${error.message}`);

  type WalletRow = { id: string; user_id: string | null; holdings: Holding[] };
  const rows = wallets as WalletRow[];

  const byUser = new Map<string, Holding[]>();
  for (const wallet of rows) {
    if (!wallet.user_id) continue; // pre-multi-tenant rows never backfilled — nothing to attribute this to
    const existing = byUser.get(wallet.user_id);
    if (existing) existing.push(...wallet.holdings);
    else byUser.set(wallet.user_id, [...wallet.holdings]);
  }

  const snapshotDate = new Date().toISOString().slice(0, 10);

  const userSnapshots = [...byUser.entries()].map(([user_id, holdings]) => {
    const { total, unpricedCount } = aggregate(holdings, prices);
    return {
      user_id,
      snapshot_date: snapshotDate,
      total_usd: total,
      unpriced_count: unpricedCount,
    };
  });

  const walletSnapshots = rows
    .filter((wallet) => wallet.user_id) // same "nothing to attribute this to" exclusion as the user rows above
    .map((wallet) => {
      const { total, unpricedCount } = aggregate(wallet.holdings, prices);
      return {
        wallet_id: wallet.id,
        snapshot_date: snapshotDate,
        total_usd: total,
        unpriced_count: unpricedCount,
      };
    });

  if (userSnapshots.length > 0) {
    const { error: upsertError } = await serviceDb()
      .from("portfolio_snapshots")
      .upsert(userSnapshots, { onConflict: "user_id,snapshot_date" });
    if (upsertError) throw new Error(`Failed to save portfolio snapshots: ${upsertError.message}`);
  }

  if (walletSnapshots.length > 0) {
    const { error: upsertError } = await serviceDb()
      .from("wallet_snapshots")
      .upsert(walletSnapshots, { onConflict: "wallet_id,snapshot_date" });
    if (upsertError) throw new Error(`Failed to save wallet snapshots: ${upsertError.message}`);
  }

  return { users: userSnapshots.length, wallets: walletSnapshots.length };
}
