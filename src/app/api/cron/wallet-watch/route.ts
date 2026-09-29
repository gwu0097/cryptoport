import type { NextRequest } from "next/server";
import { serviceDb } from "@/lib/supabase";
import { ensureAssetPrices } from "@/lib/adapters/assetPrices";
import { LANE_WORKERS, startReadWorker, type ReadLane } from "@/lib/watchReadQueue";
import type { WatchSnapshot } from "@/lib/watchSnapshot";

// Wallet Watch's daily read (docs/wallet-watch/PLAN.md, phase 2): every
// address someone watches that is due, through the same refreshWatchedAddress
// an on-demand Refresh uses — so its movements are recorded either way. Its
// own hour, after /api/cron/snapshot. This route only prepares and starts:
// one batched pricing pass, then each lane's workers (watchReadQueue.ts),
// each reading one address per invocation and starting the next — a run of
// 24 addresses no longer has to fit in one 300 s function (2026-09-29: it
// read 4). Vercel Hobby crons can be delivered twice: a second start within
// the hour is skipped, and each address is claimed by compare-and-set.
export const maxDuration = 120;

/** History kept (the screener's 400-day archive rule). */
const RETENTION_DAYS = 400;
const RUN_SETTING = "wallet_watch_run";

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const db = serviceDb();

  // A second delivery of the same cron: the lanes are already running.
  const { data: last } = await db.from("app_settings").select("value").eq("key", RUN_SETTING).maybeSingle();
  const lastStart = (last?.value as { startedAt?: string } | undefined)?.startedAt;
  if (lastStart && started - Date.parse(lastStart) < 60 * 60_000) return Response.json({ skipped: "a run started within the hour", lastStart });
  await db.from("app_settings").upsert({ key: RUN_SETTING, value: { startedAt: new Date(started).toISOString() }, updated_at: new Date(started).toISOString() });

  // Every watched coin priced once, in one batched pass, before the reads:
  // each read's own pass then only prices what's new.
  const { data: due, error } = await db.from("watched_addresses").select("snapshot").lte("next_refresh_at", new Date().toISOString()).limit(500);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const keys = (due as { snapshot: WatchSnapshot | null }[]).flatMap((r) => (r.snapshot?.rows ?? []).map((x) => x.price_key));
  await ensureAssetPrices(keys, "watch-cron").catch(() => {});

  // The lanes: each worker reads one address per invocation, then the next.
  const lanes = (Object.keys(LANE_WORKERS) as ReadLane[]).flatMap((lane) => Array.from({ length: LANE_WORKERS[lane] }, () => lane));
  const startedLanes = await Promise.allSettled(lanes.map((lane) => startReadWorker(lane)));
  const notStarted = startedLanes.flatMap((r, i) => (r.status === "rejected" ? [`${lanes[i]}: ${(r.reason as Error).message}`] : []));

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  await Promise.all([
    db.from("watched_movements").delete().lt("snapshot_at", cutoff.toISOString()),
    db.from("watched_address_daily").delete().lt("day", cutoff.toISOString().slice(0, 10)),
  ]);

  return Response.json({ due: due.length, workers: lanes.length - notStarted.length, notStarted, ms: Date.now() - started });
}
