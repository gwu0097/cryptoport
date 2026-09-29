import { getUser } from "@/lib/auth";
import { isAdminEmail } from "@/lib/adminAuth";
import { backfillActivity } from "@/lib/watchHistoryLoad";
import { HISTORY_DAYS, type HistoryDays } from "@/lib/watchHistory";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Backfills an influencer's Activity over 7 or 30 days (watchHistoryLoad.ts).
 * A route handler, so a read of a minute doesn't hold the action queue.
 * Solana addresses only for the owner (Helius credits). */
export async function POST(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { influencerId?: string; days?: number } | null;
  const days = HISTORY_DAYS.find((d) => d === body?.days) as HistoryDays | undefined;
  if (!body?.influencerId || !days) return Response.json({ error: "Expected an influencer and 7 or 30 days" }, { status: 400 });
  try {
    return Response.json(await backfillActivity(body.influencerId, days, isAdminEmail(user.email, process.env.ADMIN_EMAIL)));
  } catch (e) {
    const message = (e as Error).message;
    return Response.json({ error: message }, { status: message === "Not found" ? 404 : 500 });
  }
}
