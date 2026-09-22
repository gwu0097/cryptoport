import type { NextRequest } from "next/server";
import { runScreenerSnapshot } from "@/lib/screener/snapshot";

// Real network calls across the DefiLlama-matched universe (4 DefiLlama
// calls regardless of size, plus one CoinGecko /coins/markets call per 250
// assets) — same maxDuration precedent as this app's other real-network-
// call routes (refreshPricesAction, refreshTokenRegistryAction), well
// above the existing /api/cron/snapshot's 60s (that one does no network
// calls at all, pure in-memory aggregation over already-fetched data).
export const maxDuration = 300;

/**
 * Vercel Cron's only trigger for this route (see vercel.json) — daily.
 * Distinct path from the existing /api/cron/snapshot (portfolio value
 * snapshots, unrelated) found already running on this project while
 * planning this feature — same CRON_SECRET-bearer-token pattern as that
 * route and csp-screener's own cron routes.
 *
 * `x-vercel-cron-schedule` is set by Vercel on any request it dispatches
 * through its own cron-invocation path (both a real scheduled firing and
 * a `vercel crons run` manual trigger carry it — Vercel's own docs read
 * this header the same way) — its presence proves the request actually
 * came through Vercel's infrastructure rather than a raw curl forging the
 * CRON_SECRET or a local script bypassing HTTP entirely. It does NOT by
 * itself distinguish "genuinely automatic" from "someone ran `vercel
 * crons run`" — for that, cross-reference the recorded `started_at`
 * against the schedule (a run clustering near 07:00 UTC daily is real
 * automatic firing; one at an arbitrary time is a manual trigger).
 * Recorded into screener_runs.notes on every invocation specifically so
 * this evidence outlives Vercel's own log retention window.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const cronScheduleHeader = request.headers.get("x-vercel-cron-schedule");
  const result = await runScreenerSnapshot({
    trigger: cronScheduleHeader ? "vercel-cron" : "unknown",
    cronScheduleHeader,
  });
  return Response.json(result);
}
