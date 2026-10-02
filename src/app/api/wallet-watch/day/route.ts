import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { userDb } from "@/lib/supabase";
import { getWatchDayActivity, type WatchFeedInfluencer } from "@/lib/watchQuery";

export const dynamic = "force-dynamic";

/**
 * Today's activity lines for these influencers — what an open page fetches
 * when a live update arrives (phase 5), instead of re-rendering the whole
 * page. ~4 requests (the influencers, their addresses, their activity, the
 * prices of just those coins); the page calls it after a live update, paced
 * by liveWatching.ts. A route handler, so it doesn't wait in the action queue.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const guard = await guardUser("day", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  // Every influencer a panel can show (40 of your own, plus shared groups').
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 100);
  if (ids.length === 0) return Response.json({ coins: [], checkedAt: {}, issues: [], liveIds: [] });
  const db = await userDb();
  const [infs, addrs] = await Promise.all([
    db.from("watch_influencers").select("id, name").in("id", ids),
    db.from("watch_influencer_addresses").select("influencer_id, chain, address").in("influencer_id", ids),
  ]);
  if (infs.error || addrs.error) return Response.json({ error: (infs.error ?? addrs.error)!.message }, { status: 500 });
  const addresses = addrs.data as { influencer_id: string; chain: string; address: string }[];
  const influencers: WatchFeedInfluencer[] = (infs.data as { id: string; name: string }[]).map((i) => ({
    id: i.id,
    name: i.name,
    groupIds: [],
    addresses: addresses.filter((a) => a.influencer_id === i.id),
  }));
  return Response.json(await getWatchDayActivity(influencers, db, true), { headers: { "cache-control": "no-store" } });
}
