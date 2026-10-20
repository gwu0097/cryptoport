import "server-only";
import { serviceDb } from "./supabase";
import { NEARCOM, nearComExpired } from "./nearIntents";

export interface ExpiredNearCom {
  walletId: string;
  name: string;
  /** When the 7 days ran out; null when near.com refused it earlier. */
  since: string | null;
}

/** The user's near.com connections whose sign-in has ended (owner
 * 2026-10-19: the Dashboard says so, so they know to reconnect). One request
 * — the connection with its wallet embedded; service role (exchange
 * connections have no user policy), filtered to the user. A failure hides
 * the notice, never the page. */
export async function getExpiredNearCom(userId: string, nowMs: number): Promise<ExpiredNearCom[]> {
  const { data, error } = await serviceDb()
    .from("exchange_connections")
    .select("wallet_id, created_at, wallets!inner(name, active, exchange_sync_status)")
    .eq("user_id", userId)
    .eq("provider", NEARCOM);
  if (error) {
    console.warn(`[nearcom-expiry] read failed: ${error.message}`);
    return [];
  }
  type Row = { wallet_id: string; created_at: string | null; wallets: { name: string; active: boolean; exchange_sync_status: string | null } | null };
  const out: ExpiredNearCom[] = [];
  for (const r of (data ?? []) as unknown as Row[]) {
    if (!r.wallets?.active) continue;
    const expired = nearComExpired({ signedAt: r.created_at, syncStatus: r.wallets.exchange_sync_status }, nowMs);
    if (expired) out.push({ walletId: r.wallet_id, name: r.wallets.name, since: expired.since });
  }
  return out;
}
