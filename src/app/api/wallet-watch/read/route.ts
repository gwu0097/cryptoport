import { after } from "next/server";
import { getAssetStatsMap } from "@/lib/queries";
import { refreshWatchedAddress } from "@/lib/watchRefresh";
import { claimNextInLane, startReadWorker, type ReadLane } from "@/lib/watchReadQueue";

export const dynamic = "force-dynamic";
// One address per invocation: its own 300 s (a read was 87–177 s on 2026-09-29).
export const maxDuration = 300;

/**
 * One link of a Wallet Watch read lane (watchReadQueue.ts): answers at once,
 * then — after the response — claims the next due address of its lane,
 * reads it, and starts the next link. The lane ends when nothing is due.
 * Started by the daily cron; gated by CRON_SECRET.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  const { lane } = ((await request.json().catch(() => ({}))) ?? {}) as { lane?: ReadLane };
  if (lane !== "evm" && lane !== "solana" && lane !== "other") return Response.json({ error: "Unknown lane" }, { status: 400 });

  after(async () => {
    const next = await claimNextInLane(lane).catch((e: Error) => {
      console.error(`[watch-lane] ${lane}: claim failed: ${e.message}`);
      return null;
    });
    if (!next) {
      console.log(`[watch-lane] ${lane}: done`);
      return;
    }
    const stats = await getAssetStatsMap().catch(() => new Map());
    await refreshWatchedAddress(next, stats); // never throws
    await startReadWorker(lane).catch((e: Error) => console.error(`[watch-lane] ${lane}: next link not started: ${e.message}`));
  });
  return Response.json({ ok: true, lane });
}
