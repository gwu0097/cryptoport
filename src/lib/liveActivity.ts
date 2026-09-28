import "server-only";
import { serviceDb } from "./supabase";
import { readAssetPrices } from "./adapters/assetPrices";
import { identifyLegs } from "./watchActivityCheck";
import { broadcastActivity } from "./liveBroadcast";
import { appendLegs, type ActivityBase, type TxActivity } from "./watchActivity";
import { accountKeys, rawTxChanges, worthSaving, type RawWebhookTx } from "./webhookTx";
import { assetStates } from "./watchDiff";
import type { WatchSnapshot } from "./watchSnapshot";

// Wallet Watch live activity (docs/wallet-watch/PLAN.md, phase 5): what a
// Helius "raw" webhook delivers, saved as legs on the watched address's
// tx_activity — the same store Refresh activity writes, deduped by
// transaction, tagged "webhook". Spam (a token that only arrived) is dropped
// before any request; the cursor isn't moved, so a Refresh still reads the
// same history and counts anything the webhook missed.

/** Live addresses, cached in the process: every delivery needs them. */
let liveCache: { at: number; addresses: Set<string> } | null = null;
const LIVE_CACHE_MS = 60_000;

async function liveAddresses(): Promise<Set<string>> {
  if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_MS) return liveCache.addresses;
  const { data, error } = await serviceDb().from("watched_addresses").select("address").eq("chain", "SOL").eq("live", true);
  if (error) throw new Error(`Failed to load live addresses: ${error.message}`);
  liveCache = { at: Date.now(), addresses: new Set((data as { address: string }[]).map((r) => r.address)) };
  return liveCache.addresses;
}

/** Forget the cached list (after the live set changes). */
export function clearLiveCache(): void {
  liveCache = null;
}

export interface DeliveryOutcome {
  transactions: number;
  saved: number;
  skipped: number;
}

/** One webhook delivery (an array of raw transactions). */
export async function saveDelivery(txs: readonly RawWebhookTx[]): Promise<DeliveryOutcome> {
  const live = await liveAddresses();
  const perOwner = new Map<string, ReturnType<typeof rawTxChanges>>();
  let skipped = 0;
  for (const tx of txs) {
    const owners = new Set(accountKeys(tx).filter((k) => live.has(k)));
    for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) if (b.owner && live.has(b.owner)) owners.add(b.owner);
    for (const owner of owners) {
      const changes = rawTxChanges(tx, owner);
      if (!worthSaving(changes)) {
        skipped++;
        continue;
      }
      perOwner.set(owner, [...(perOwner.get(owner) ?? []), ...changes]);
    }
  }
  if (perOwner.size === 0) return { transactions: txs.length, saved: 0, skipped };

  const db = serviceDb();
  const { data, error } = await db.from("watched_addresses").select("address, snapshot, tx_activity, last_refresh_at").eq("chain", "SOL").in("address", [...perOwner.keys()]);
  if (error) throw new Error(`Failed to load addresses: ${error.message}`);
  const now = new Date().toISOString();
  let saved = 0;
  for (const row of data as { address: string; snapshot: WatchSnapshot | null; tx_activity: TxActivity | null; last_refresh_at: string | null }[]) {
    if (!row.snapshot || !row.last_refresh_at) continue; // not read yet: nothing to compare with
    const boundary = row.snapshot.readStartedAt ?? row.last_refresh_at;
    const legs = await identifyLegs(perOwner.get(row.address)!, row.snapshot, readAssetPrices, now, "webhook");
    const states = assetStates(row.snapshot);
    const base: Record<string, ActivityBase> = {};
    for (const l of legs) base[l.assetKey] = { qty: states.get(l.assetKey)?.qty ?? 0, kept: states.get(l.assetKey)?.kept ?? false };
    const activity = appendLegs(row.tx_activity, boundary, legs, base);
    // Only onto the same read (a full read that finished meanwhile moved the day).
    const { error: saveError } = await db
      .from("watched_addresses")
      .update({ tx_activity: activity, live_last_event_at: now })
      .eq("chain", "SOL")
      .eq("address", row.address)
      .eq("last_refresh_at", row.last_refresh_at);
    if (saveError) throw new Error(saveError.message);
    // Only what's new (a duplicate delivery, or a trade Refresh already saved, adds nothing).
    saved += activity.legs.length - (row.tx_activity?.boundary === boundary ? row.tx_activity.legs.length : 0);
  }
  if (saved > 0) await broadcastActivity(); // new lines: open pages fetch theirs (one request)
  return { transactions: txs.length, saved, skipped };
}
