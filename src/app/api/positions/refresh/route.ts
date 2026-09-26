import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { getPerpMarks, openPositionsOf } from "@/lib/queries";
import { planPositionRefresh, refreshVenue } from "@/lib/positionsRefresh";
import { venueOwns } from "@/lib/perpPositions";
import type { Holding } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Refresh positions", streamed: every venue account is re-read at once
 * (positionsRefresh.ts), and each one's fresh open positions are sent the
 * moment it's saved, one JSON line each — so the Dashboard's section fills in
 * account by account (the way Rabby/DeBank show a sync counting up) instead
 * of waiting for the slowest. A route handler, not a Server Action: actions
 * run one at a time per tab, so a long refresh would also hold up navigation.
 *
 * Lines: {type:"start", total, accounts:[{walletId, walletName, venueId}]},
 * then per account {type:"account", walletId, venueId, ok, positions | error},
 * then {type:"end"}.
 */
export async function POST(): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const db = await userDb();
  const tasks = await planPositionRefresh(db);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      send({ type: "start", total: tasks.length, accounts: tasks.map((t) => ({ walletId: t.wallet.id, walletName: t.wallet.name, venueId: t.venue.id })) });
      await Promise.all(
        tasks.map(async (task) => {
          try {
            await refreshVenue(db, task);
            // Read back what was saved, so the positions shown are exactly
            // what the page will show after its final refresh.
            const [{ data, error }, { data: w }] = await Promise.all([
              db.from("holdings").select("*").eq("wallet_id", task.wallet.id).eq("chain", task.venue.chain),
              db.from("wallets").select("last_refresh_at").eq("id", task.wallet.id).single(),
            ]);
            if (error) throw new Error(error.message);
            const rows = (data as Holding[]).filter((h) => venueOwns(task.venue, h));
            const positions = openPositionsOf({ id: task.wallet.id, name: task.wallet.name, last_refresh_at: w?.last_refresh_at ?? null }, rows, await getPerpMarks());
            send({ type: "account", walletId: task.wallet.id, venueId: task.venue.id, ok: true, positions });
          } catch (e) {
            send({ type: "account", walletId: task.wallet.id, venueId: task.venue.id, ok: false, error: (e as Error).message });
          }
        }),
      );
      revalidatePath("/", "layout");
      send({ type: "end" });
      controller.close();
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
