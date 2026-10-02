import { after } from "next/server";
import { serviceDb } from "@/lib/supabase";
import { ensureAssetPrices } from "@/lib/adapters/assetPrices";
import { freeSlots, startReadWorker, type ReadLane } from "@/lib/watchReadQueue";
import { releaseUnwatched, sweepLive } from "@/lib/liveBotGuard";
import type { WatchSnapshot } from "@/lib/watchSnapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** History kept (the screener's 400-day archive rule). */
const RETENTION_DAYS = 400;
/** A wallet searched but never named (Wallet search) is removed after this. */
const UNSAVED_DAYS = 10;
/** The day's prep marker (app_settings): once per morning. */
const RUN_SETTING = "wallet_watch_run";

/**
 * Wallet Watch's daily read, one tick (watchReadQueue.ts): Supabase pg_cron
 * calls this every minute from 08:00 to 09:59 UTC while an address someone
 * watches is due. Answers at once; then, the first tick of the day, one
 * batched pricing pass and the retention trim; then one read per free lane
 * slot. Each read claims one address and stops — nothing chains.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  // Hop depth through Vercel (its 508 loop limit): a tick from pg_net should be 1.
  const hops = (request.headers.get("x-vercel-id") ?? "").split("::")[0].split(":").length;

  after(async () => {
    const db = serviceDb();
    const now = Date.now();
    const { data: last } = await db.from("app_settings").select("value").eq("key", RUN_SETTING).maybeSingle();
    const lastPrep = (last?.value as { startedAt?: string } | undefined)?.startedAt;
    if (!lastPrep || now - Date.parse(lastPrep) > 20 * 60 * 60_000) {
      await db.from("app_settings").upsert({ key: RUN_SETTING, value: { startedAt: new Date(now).toISOString() }, updated_at: new Date(now).toISOString() });
      // Every due coin priced once, before the reads: each read's own pass
      // then only prices what's new.
      const { data: due } = await db.from("watched_addresses").select("snapshot").lte("next_refresh_at", new Date(now).toISOString()).limit(500);
      const keys = ((due ?? []) as { snapshot: WatchSnapshot | null }[]).flatMap((r) => (r.snapshot?.rows ?? []).map((x) => x.price_key));
      await ensureAssetPrices(keys, "watch-cron").catch(() => {});
      const cutoff = new Date(now - RETENTION_DAYS * 86_400_000);
      // Unsaved searches past 10 days, and their addresses released from live.
      const { data: expired } = await db.from("watch_influencers").select("id, watch_influencer_addresses(chain, address)").lt("unsaved_since", new Date(now - UNSAVED_DAYS * 86_400_000).toISOString());
      const expiredRows = (expired ?? []) as { id: string; watch_influencer_addresses: { chain: string; address: string }[] }[];
      await Promise.all([
        db.from("watched_movements").delete().lt("snapshot_at", cutoff.toISOString()),
        db.from("watched_address_daily").delete().lt("day", cutoff.toISOString().slice(0, 10)),
        expiredRows.length ? db.from("watch_influencers").delete().in("id", expiredRows.map((r) => r.id)) : Promise.resolve(),
      ]);
      // The live set, once a day: unwatched or bot-busy addresses off, the
      // providers' webhooks synced to the database, a Discord line (liveBotGuard.ts).
      await releaseUnwatched(expiredRows.flatMap((r) => r.watch_influencer_addresses)).catch((e: Error) => console.error(`[watch-tick] release: ${e.message}`));
      await sweepLive().catch((e: Error) => console.error(`[watch-tick] live sweep: ${e.message}`));
    }
    const slots = await freeSlots().catch((e: Error) => {
      console.error(`[watch-tick] slots: ${e.message}`);
      return null;
    });
    if (!slots) return;
    const starts = (Object.keys(slots) as ReadLane[]).flatMap((lane) => Array.from({ length: slots[lane] }, () => lane));
    const results = await Promise.allSettled(starts.map((lane) => startReadWorker(lane)));
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${starts[i]}: ${(r.reason as Error).message}`] : []));
    console.log(`[watch-tick] ${JSON.stringify({ hops, started: starts, failed })}`);
  });
  return Response.json({ ok: true });
}
