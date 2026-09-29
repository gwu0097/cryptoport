import type { NextRequest } from "next/server";
import { LANE_WORKERS, stalledLanes, startReadWorker } from "@/lib/watchReadQueue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The daily read's safety net (09:00, 10:00, 11:00 UTC): restarts each
 * Wallet Watch read lane that still has addresses due but hasn't claimed
 * one in JOB_STALE_MS — its chain of links died. Lanes still running, and a
 * finished run, are left alone: two requests, nothing else.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  const lanes = await stalledLanes();
  const starts = lanes.flatMap((lane) => Array.from({ length: LANE_WORKERS[lane] }, () => lane));
  const results = await Promise.allSettled(starts.map((lane) => startReadWorker(lane)));
  const notStarted = results.flatMap((r, i) => (r.status === "rejected" ? [`${starts[i]}: ${(r.reason as Error).message}`] : []));
  return Response.json({ restarted: lanes, workers: starts.length - notStarted.length, notStarted });
}
