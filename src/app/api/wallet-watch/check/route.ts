import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { userDb } from "@/lib/supabase";
import { getAssetStatsMap } from "@/lib/queries";
import { runActivityCheck } from "@/lib/watchActivityCheck";

export const dynamic = "force-dynamic";
// Addresses run a few at a time, each ~1–5 s (a busy Solana wallet pages up
// to 5 times); what isn't reached in time is simply not checked this time.
export const maxDuration = 60;

/**
 * Wallet Watch's activity check (docs/wallet-watch/PLAN.md, phase 4),
 * streamed: each address's result is sent the moment it's saved, so the
 * button counts up and nothing polls (CLAUDE.md §6). A route handler, not a
 * Server Action, so it doesn't hold up the tab's other clicks.
 *
 * Body: {influencerIds?: string[]} — the selected group's; all when absent.
 * Lines: {type:"start", total}, per address {type:"address", chain, address,
 * ok, status}, then {type:"end"}.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const guard = await guardUser("check", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { influencerIds?: string[] };
  const db = await userDb();
  let query = db.from("watch_influencer_addresses").select("chain, address");
  if (Array.isArray(body.influencerIds)) query = query.in("influencer_id", body.influencerIds);
  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const keys = [...new Map((data as { chain: string; address: string }[]).map((k) => [`${k.chain}|${k.address}`, k])).values()];
  const stats = await getAssetStatsMap();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      send({ type: "start", total: keys.length });
      try {
        await runActivityCheck(keys, stats, (o) => send({ type: "address", ...o }));
      } catch (e) {
        send({ type: "error", error: (e as Error).message });
      }
      revalidatePath("/", "layout");
      send({ type: "end" });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
