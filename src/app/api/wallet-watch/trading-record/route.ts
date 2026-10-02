import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { userDb } from "@/lib/supabase";
import { loadTradingRecords } from "@/lib/tradingRecordLoad";

export const dynamic = "force-dynamic";
// An EVM address's first load is 15 Zerion calls a second apart.
export const maxDuration = 120;

/**
 * "Load trading record" on an influencer's page: its Solana addresses'
 * records from Solana Tracker, its EVM addresses' from Zerion (reused for an
 * hour; tradingRecordLoad.ts). A route handler, not a Server Action, so the
 * seconds it takes don't hold up the tab.
 * Body: {influencerId}. Only an influencer the user watches (RLS).
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const guard = await guardUser("tradingRecord", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  const { influencerId } = (await request.json().catch(() => ({}))) as { influencerId?: string };
  if (!influencerId) return Response.json({ error: "No influencer" }, { status: 400 });
  const db = await userDb();
  const { data, error } = await db.from("watch_influencer_addresses").select("chain, address").eq("influencer_id", influencerId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const outcomes = await loadTradingRecords(data as { chain: string; address: string }[], Date.now());
  revalidatePath(`/wallet-watch/${influencerId}`);
  return Response.json({ outcomes });
}
