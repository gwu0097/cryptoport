import type { NextRequest } from "next/server";
import { serviceDb } from "@/lib/supabase";
import { ensureAssetPrices } from "@/lib/adapters/assetPrices";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { getAssetStatsMap } from "@/lib/queries";
import { claimWatchedAddresses, refreshWatchedAddress, type WatchedKey } from "@/lib/watchRefresh";
import type { WatchSnapshot } from "@/lib/watchSnapshot";

// Wallet Watch's daily read (docs/wallet-watch/PLAN.md, phase 2): every
// address someone watches that is due, oldest first, through the same
// refreshWatchedAddress an on-demand Refresh uses — so its movements are
// recorded either way. Its own hour, after /api/cron/snapshot. Vercel Hobby
// crons run once a day and can be delivered twice: each address is claimed
// by compare-and-set, and a movement is unique per read, so a second delivery
// does nothing new. What doesn't fit in one run waits for the next and shows
// its real "last read".
export const maxDuration = 300;

/** Stop starting new reads after this, leaving time to finish the last. */
const BUDGET_MS = 240_000;
const CONCURRENCY = 2;
const BATCH = 200;
/** History kept (the screener's 400-day archive rule). */
const RETENTION_DAYS = 400;

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const db = serviceDb();

  // Due, and still watched by someone.
  const [{ data: due, error }, { data: watchedBy, error: watchedError }] = await Promise.all([
    db.from("watched_addresses").select("chain, address, snapshot").lte("next_refresh_at", new Date().toISOString()).order("next_refresh_at").limit(BATCH),
    db.from("watch_influencer_addresses").select("chain, address"),
  ]);
  if (error || watchedError) return Response.json({ error: (error ?? watchedError)!.message }, { status: 500 });
  const watched = new Set((watchedBy as WatchedKey[]).map((k) => `${k.chain}|${k.address}`));
  const rows = (due as (WatchedKey & { snapshot: WatchSnapshot | null })[]).filter((r) => watched.has(`${r.chain}|${r.address}`));

  // Every watched coin priced once, in one batched pass, before the reads.
  const keys = rows.flatMap((r) => (r.snapshot?.rows ?? []).map((x) => x.price_key));
  await ensureAssetPrices(keys, "watch-cron").catch(() => {});
  const stats = await getAssetStatsMap().catch(() => new Map());

  const claimed = await claimWatchedAddresses(rows.map(({ chain, address }) => ({ chain, address })));
  let read = 0;
  const skipped: WatchedKey[] = [];
  await mapWithConcurrency(claimed, CONCURRENCY, async (k) => {
    if (Date.now() - started > BUDGET_MS) {
      skipped.push(k);
      return;
    }
    await refreshWatchedAddress(k, stats);
    read++;
  });
  // Claimed but not reached: released, still due for the next run.
  for (const k of skipped) {
    await db.from("watched_addresses").update({ refresh_status: null }).eq("chain", k.chain).eq("address", k.address);
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  await Promise.all([
    db.from("watched_movements").delete().lt("snapshot_at", cutoff.toISOString()),
    db.from("watched_address_daily").delete().lt("day", cutoff.toISOString().slice(0, 10)),
  ]);

  return Response.json({ due: rows.length, claimed: claimed.length, read, deferred: skipped.length, ms: Date.now() - started });
}
