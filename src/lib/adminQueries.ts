import "server-only";
import { serviceDb, serviceAuth } from "./supabase";
import { aggregate } from "./valuation";
import { getPriceMap } from "./queries";
import { walletDisplayName } from "./walletDisplay";
import type { Holding } from "./types";

export interface AdminUserSummary {
  id: string;
  /** Real email, or (for a wallet-only account) a truncated wallet address
   * — see walletDisplayName's own doc comment. Never a raw
   * @wallet.cryptoport.invalid string; that's meaningless to a person. */
  displayName: string;
  createdAt: string;
  lastSignInAt: string | null;
  walletCount: number;
  totalUsd: number;
}

/**
 * Every registered user, cross-referenced with a wallet-count/total-value
 * summary — admin-only (see src/lib/adminAuth.ts; every caller of this
 * must have already called requireAdmin()). serviceAuth().listUsers() for
 * identity (the auth.admin wrapper already existed for the wallet sign-in
 * flow, unused for a cross-user list until now); the wallets/holdings pass
 * mirrors capturePortfolioSnapshots' own byUser grouping (snapshots.ts) —
 * same aggregate() primitives everything else in this app uses for a
 * total, so this number can never quietly disagree with what the app
 * itself would show that user. Sorted most-recently-active first — "who's
 * actually using it" is a more useful default than signup order.
 */
export async function listAdminUsers(): Promise<AdminUserSummary[]> {
  const [{ data: authData, error: authError }, { data: wallets, error: walletsError }, prices] = await Promise.all([
    serviceAuth().listUsers(),
    serviceDb().from("wallets").select("id, user_id, holdings(*)").eq("active", true),
    getPriceMap(),
  ]);
  if (authError) throw new Error(`Failed to list users: ${authError.message}`);
  if (walletsError) throw new Error(`Failed to load wallets for admin summary: ${walletsError.message}`);

  type WalletRow = { id: string; user_id: string | null; holdings: Holding[] };
  const rows = wallets as WalletRow[];

  const byUser = new Map<string, { walletCount: number; holdings: Holding[] }>();
  for (const wallet of rows) {
    if (!wallet.user_id) continue;
    const existing = byUser.get(wallet.user_id);
    if (existing) {
      existing.walletCount += 1;
      existing.holdings.push(...wallet.holdings);
    } else {
      byUser.set(wallet.user_id, { walletCount: 1, holdings: [...wallet.holdings] });
    }
  }

  return authData.users
    .map((user) => {
      const summary = byUser.get(user.id);
      const { total } = aggregate(summary?.holdings ?? [], prices);
      return {
        id: user.id,
        displayName: walletDisplayName(user) ?? user.email ?? "(no email)",
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at ?? null,
        walletCount: summary?.walletCount ?? 0,
        totalUsd: total,
      };
    })
    .sort((a, b) => {
      // Never-signed-in accounts (lastSignInAt null) sort last, not first —
      // same "missing is never treated as the smallest/most-recent real
      // value" rule this app applies everywhere else.
      if (!a.lastSignInAt && !b.lastSignInAt) return 0;
      if (!a.lastSignInAt) return 1;
      if (!b.lastSignInAt) return -1;
      return b.lastSignInAt.localeCompare(a.lastSignInAt);
    });
}

export interface AdminTargetUser {
  id: string;
  displayName: string;
}

/** The one target-user lookup every /admin/[userId] page needs for its
 * "Viewing {name} — read-only" banner — admin-only, same caller
 * requirement as listAdminUsers above. */
export async function getAdminTargetUser(userId: string): Promise<AdminTargetUser | null> {
  const { data, error } = await serviceAuth().getUserById(userId);
  if (error || !data.user) return null;
  return { id: data.user.id, displayName: walletDisplayName(data.user) ?? data.user.email ?? "(no email)" };
}
