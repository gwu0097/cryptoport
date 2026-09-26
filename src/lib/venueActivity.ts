import "server-only";
import type { userDb } from "./supabase";
import { venuesWithOpenPositions } from "./perpPositions";

// When each wallet's venue account last had an open position
// (cryptoport.wallet_venue_activity) — what keeps a venue in "Refresh
// positions" for RECENT_POSITION_WINDOW_MS after its last position closes
// (perpPositions.ts venuesToRefresh). Written by the wallet sync and by the
// refresh whenever a venue's fresh rows show an open position. Best-effort:
// a failed write or read only narrows the next refresh to venues with an open
// position now, as before.

type Db = Awaited<ReturnType<typeof userDb>>;
type Row = Parameters<typeof venuesWithOpenPositions>[0][number];

/** Marks now as the last time each venue in `rows` had an open position. */
export async function markVenueActivity(db: Db, walletId: string, rows: readonly Row[]): Promise<void> {
  const venues = venuesWithOpenPositions(rows);
  if (venues.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await db
    .from("wallet_venue_activity")
    .upsert(venues.map((v) => ({ wallet_id: walletId, venue: v.id, last_position_at: now })), { onConflict: "wallet_id,venue" });
  if (error) console.warn(`[venue activity] wallet ${walletId}: ${error.message}`);
}

/** wallet id → (venue id → last position time), for the given wallets. */
export async function readVenueActivity(db: Db, walletIds: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (walletIds.length === 0) return out;
  const { data, error } = await db.from("wallet_venue_activity").select("wallet_id, venue, last_position_at").in("wallet_id", [...walletIds]);
  if (error) {
    console.warn(`[venue activity] read: ${error.message}`);
    return out;
  }
  for (const r of data as { wallet_id: string; venue: string; last_position_at: string }[]) {
    const m = out.get(r.wallet_id) ?? new Map<string, string>();
    m.set(r.venue, r.last_position_at);
    out.set(r.wallet_id, m);
  }
  return out;
}
