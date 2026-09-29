import { after } from "next/server";
import { refreshWatchedAddress } from "@/lib/watchRefresh";
import { claimNextInLane, type ReadLane } from "@/lib/watchReadQueue";

export const dynamic = "force-dynamic";
// One address per invocation: its own 300 s.
export const maxDuration = 300;

/**
 * One Wallet Watch read (watchReadQueue.ts), started by the tick: answers at
 * once, then claims the next due address of its lane, reads it and stops.
 * It never starts another read — Vercel refuses a function calling its own
 * site after ~4 hops (HTTP 508). Gated by CRON_SECRET.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  const { lane } = ((await request.json().catch(() => ({}))) ?? {}) as { lane?: ReadLane };
  if (lane !== "evm" && lane !== "solana" && lane !== "other") return Response.json({ error: "Unknown lane" }, { status: 400 });
  const hops = (request.headers.get("x-vercel-id") ?? "").split("::")[0].split(":").length;

  after(async () => {
    const next = await claimNextInLane(lane).catch((e: Error) => {
      console.error(`[watch-lane] ${lane}: claim failed: ${e.message}`);
      return null;
    });
    if (!next) return;
    console.log(`[watch-lane] ${lane}: reading ${next.chain}:${next.address} (hops ${hops})`);
    await refreshWatchedAddress(next); // never throws; logs its own [watch-read] line
  });
  return Response.json({ ok: true, lane });
}
