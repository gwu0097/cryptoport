import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { getPerpMarks, openPositionsOf } from "@/lib/queries";
import { planPositionRefresh, refreshVenue } from "@/lib/positionsRefresh";
import { markKeyFor, venueOwns } from "@/lib/perpPositions";
import { refreshAssetPrices } from "@/lib/adapters/assetPrices";
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
 * The positions' venue marks are refreshed with them (only those keys, one
 * call per venue), so the Mark / Entry → Now shown is current.
 *
 * Lines: {type:"start", total, accounts:[{walletId, walletName, venueId}]},
 * then per account {type:"account", walletId, venueId, ok, positions | error},
 * then {type:"end"}.
 */
export async function POST(): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const db = await userDb();
  // The venues' marks too (owner 2026-10-13: "Refresh positions doesn't update
  // mark") — only the perp-mark keys of the positions held, one call per
  // venue (Hyperliquid, Lighter, Aster), alongside the account reads; never
  // the rest of the prices.
  const markKeys = (rows: { chain: string | null; ticker: string; contract?: string | null }[]) => [...new Set(rows.map((h) => markKeyFor(h)).filter((k): k is string => !!k))];
  const [tasks, { data: held }] = await Promise.all([planPositionRefresh(db), db.from("holdings").select("chain, ticker, contract").not("position_side", "is", null)]);
  const known = markKeys((held ?? []) as { chain: string | null; ticker: string; contract: string | null }[]);
  const marksNow = known.length ? refreshAssetPrices("positions", known).catch(() => null) : Promise.resolve(null);
  const seen = new Set<string>();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      send({ type: "start", total: tasks.length, accounts: tasks.map((t) => ({ walletId: t.wallet.id, walletName: t.wallet.name, venueId: t.venue.id })) });
      await Promise.all(
        tasks.map(async (task) => {
          try {
            await refreshVenue(db, task);
            await marksNow;
            // Read back what was saved, so the positions shown are exactly
            // what the page will show after its final refresh.
            const [{ data, error }, { data: w }] = await Promise.all([
              db.from("holdings").select("*").eq("wallet_id", task.wallet.id).eq("chain", task.venue.chain),
              db.from("wallets").select("last_refresh_at").eq("id", task.wallet.id).single(),
            ]);
            if (error) throw new Error(error.message);
            const rows = (data as Holding[]).filter((h) => venueOwns(task.venue, h));
            for (const k of markKeys(rows.filter((h) => h.position_side))) seen.add(k);
            const positions = openPositionsOf({ id: task.wallet.id, name: task.wallet.name, last_refresh_at: w?.last_refresh_at ?? null }, rows, await getPerpMarks());
            send({ type: "account", walletId: task.wallet.id, venueId: task.venue.id, ok: true, positions });
          } catch (e) {
            send({ type: "account", walletId: task.wallet.id, venueId: task.venue.id, ok: false, error: (e as Error).message });
          }
        }),
      );
      // A position opened since the last read: its mark now, before the
      // page's final render.
      const fresh = [...seen].filter((k) => !known.includes(k));
      if (fresh.length) await refreshAssetPrices("positions", fresh).catch(() => null);
      revalidatePath("/", "layout");
      send({ type: "end" });
      controller.close();
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
