import { getUser } from "@/lib/auth";
import { loadRecentTrades } from "@/lib/watchHistoryLoad";
import { HISTORY_DAYS, type HistoryDays } from "@/lib/watchHistory";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** An influencer's recent EVM trades (watchHistoryLoad.ts), on demand. A
 * route handler, so a read of half a minute doesn't hold the action queue. */
export async function POST(request: Request): Promise<Response> {
  if (!(await getUser())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { influencerId?: string; days?: number } | null;
  const days = HISTORY_DAYS.find((d) => d === body?.days) as HistoryDays | undefined;
  if (!body?.influencerId || !days) return Response.json({ error: "Expected an influencer and 7 or 30 days" }, { status: 400 });
  try {
    return Response.json(await loadRecentTrades(body.influencerId, days));
  } catch (e) {
    const message = (e as Error).message;
    return Response.json({ error: message }, { status: message === "Not found" ? 404 : 500 });
  }
}
