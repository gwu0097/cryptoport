import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { loadTradingRecords } from "@/lib/tradingRecordLoad";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Load trading record" on an influencer's page: its Solana addresses'
 * records from Solana Tracker (2 requests each, reused for an hour). A route
 * handler, not a Server Action, so the few seconds don't hold up the tab.
 * Body: {influencerId}. Only an influencer the user watches (RLS).
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const { influencerId } = (await request.json().catch(() => ({}))) as { influencerId?: string };
  if (!influencerId) return Response.json({ error: "No influencer" }, { status: 400 });
  const db = await userDb();
  const { data, error } = await db.from("watch_influencer_addresses").select("chain, address").eq("influencer_id", influencerId).eq("chain", "SOL");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const outcomes = await loadTradingRecords((data as { address: string }[]).map((a) => a.address), Date.now());
  revalidatePath(`/wallet-watch/${influencerId}`);
  return Response.json({ outcomes });
}
