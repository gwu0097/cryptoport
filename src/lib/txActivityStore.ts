import "server-only";
import { serviceDb } from "./supabase";
import { appendLegs, type ActivityBase, type ActivityLeg, type TxActivity } from "./watchActivity";

// The one way to change a watched address's tx_activity (phase 5): a
// compare-and-set on its tx_version, retried with a fresh read when another
// writer got there first. The webhook, Refresh activity and the morning read
// all write it; read-modify-write without this lost trades whenever two
// webhook deliveries landed in the same second (Risk, 2026-09-28: 6 trades).

const MAX_TRIES = 6;

/** Appends legs (deduped by transaction) and sets `extra` fields, onto the
 * same full read only (`lastRefreshAt`). Returns how many legs were new, or
 * null when a full read finished meanwhile (the day moved). */
export async function appendActivity(
  chain: string,
  address: string,
  lastRefreshAt: string,
  boundary: string,
  legs: readonly ActivityLeg[],
  base: Record<string, ActivityBase>,
  extra: Record<string, unknown> = {},
): Promise<number | null> {
  const db = serviceDb();
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const { data: row, error } = await db.from("watched_addresses").select("tx_activity, tx_version, last_refresh_at").eq("chain", chain).eq("address", address).single();
    if (error) throw new Error(error.message);
    if (row.last_refresh_at !== lastRefreshAt && Date.parse(row.last_refresh_at) !== Date.parse(lastRefreshAt)) return null;
    const prev = (row.tx_activity as TxActivity | null) ?? null;
    const activity = appendLegs(prev, boundary, legs, base);
    const added = activity.legs.length - (prev?.boundary === boundary ? prev.legs.length : 0);
    const { data: saved, error: saveError } = await db
      .from("watched_addresses")
      .update({ tx_activity: activity, tx_version: (row.tx_version as number) + 1, ...extra })
      .eq("chain", chain)
      .eq("address", address)
      .eq("tx_version", row.tx_version)
      .select("chain");
    if (saveError) throw new Error(saveError.message);
    if (saved && saved.length > 0) return added;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150)); // someone else wrote: read again
  }
  throw new Error("Couldn't save the activity: too many writers at once");
}

/** Rewrites tx_activity with `next(prev)` under the same compare-and-set
 * (the morning read's trim of the legs its snapshot now covers). */
export async function rewriteActivity(chain: string, address: string, next: (prev: TxActivity | null) => TxActivity | null): Promise<void> {
  const db = serviceDb();
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const { data: row, error } = await db.from("watched_addresses").select("tx_activity, tx_version").eq("chain", chain).eq("address", address).single();
    if (error) throw new Error(error.message);
    const { data: saved, error: saveError } = await db
      .from("watched_addresses")
      .update({ tx_activity: next((row.tx_activity as TxActivity | null) ?? null), tx_version: (row.tx_version as number) + 1 })
      .eq("chain", chain)
      .eq("address", address)
      .eq("tx_version", row.tx_version)
      .select("chain");
    if (saveError) throw new Error(saveError.message);
    if (saved && saved.length > 0) return;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
  }
  throw new Error("Couldn't update the activity: too many writers at once");
}
