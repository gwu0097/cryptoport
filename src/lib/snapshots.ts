import "server-only";
import { serviceDb } from "./supabase";
import { aggregate } from "./valuation";
import { getPriceMap } from "./queries";
import type { Holding } from "./types";

/**
 * Captures one row per user into cryptoport.portfolio_snapshots, and one
 * row per wallet into cryptoport.wallet_snapshots — the Dashboard's
 * value-history chart and Analytics' per-wallet breakdown are both built
 * entirely from these. This is the bulk, once-a-day writer (see the cron
 * route this is called from) that guarantees every user gets at least one
 * snapshot per day regardless of whether they open the app — see
 * captureUserSnapshot below for the per-user writer a manual refresh/sync
 * also calls, so the chart doesn't sit stuck at whatever this run
 * captured if the user refreshes again later the same day. Runs across
 * every active wallet for every user in one pass via serviceDb() (no
 * session, so no per-user userDb() call is possible here) rather than
 * looping a per-user query — one shared getPriceMap() read, same
 * primitives (aggregate from valuation.ts) the live "Total value" panel
 * uses, so a snapshot always agrees with what the app showed that day.
 * The wallet rows are built from the exact same holdings list as the user
 * rows, so a wallet's total and the user total it rolls into can never
 * disagree. Both writers upsert on the same (user_id/wallet_id,
 * snapshot_date) key, so whichever one runs later in a given day simply
 * wins — there's only ever one row per day either way.
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

/**
 * Same upsert this file's cron entry point does, scoped to one user —
 * called after that user's own price refresh or wallet sync finishes, so
 * today's snapshot (and with it, the Value history chart's most recent
 * point) reflects what just changed instead of sitting stuck at whatever
 * the once-daily cron captured earlier. Reported directly: "Total value"
 * and the chart's headline number visibly disagreed after a manual
 * refresh, and "shouldn't a sync match them?" is a real, better fix than
 * just captioning the gap — this closes it going forward, though the cron
 * remains the one guarantee that *every* user gets a snapshot at least
 * once a day even if they never touch the app that day.
 *
 * A single small upsert per (user, wallet) — negligible cost added to a
 * refresh/sync that's already doing real work, and always run from inside
 * an existing after() callback, so it can never block the click response
 * that triggered it either way.
 */
export async function captureUserSnapshot(userId: string): Promise<void> {
  const [{ data: wallets, error }, prices] = await Promise.all([
    serviceDb().from("wallets").select("id, holdings(*)").eq("active", true).eq("user_id", userId),
    getPriceMap(),
  ]);
  if (error) throw new Error(`Failed to load wallets for snapshot: ${error.message}`);

  type WalletRow = { id: string; holdings: Holding[] };
  const rows = wallets as WalletRow[];
  const snapshotDate = new Date().toISOString().slice(0, 10);

  const allHoldings = rows.flatMap((w) => w.holdings);
  const { total, unpricedCount } = aggregate(allHoldings, prices);
  const { error: userUpsertError } = await serviceDb()
    .from("portfolio_snapshots")
    .upsert(
      { user_id: userId, snapshot_date: snapshotDate, total_usd: total, unpriced_count: unpricedCount },
      { onConflict: "user_id,snapshot_date" },
    );
  if (userUpsertError) throw new Error(`Failed to save portfolio snapshot: ${userUpsertError.message}`);

  const walletSnapshots = rows.map((wallet) => {
    const { total: walletTotal, unpricedCount: walletUnpriced } = aggregate(wallet.holdings, prices);
    return {
      wallet_id: wallet.id,
      snapshot_date: snapshotDate,
      total_usd: walletTotal,
      unpriced_count: walletUnpriced,
    };
  });
  if (walletSnapshots.length > 0) {
    const { error: walletUpsertError } = await serviceDb()
      .from("wallet_snapshots")
      .upsert(walletSnapshots, { onConflict: "wallet_id,snapshot_date" });
    if (walletUpsertError) throw new Error(`Failed to save wallet snapshots: ${walletUpsertError.message}`);
  }
}
