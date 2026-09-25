import "server-only";
import { getUser } from "@/lib/auth";
import { userDb, serviceDb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * The lightweight half of this app's job-polling system — every field a
 * busy job button anywhere in the app needs to know "is this still
 * running," in one small, cheap read (no holdings, no prices, no
 * valuation math). Polled directly via `fetch()` from JobPoller.tsx rather
 * than through a Server Action specifically because Server Actions share
 * one sequential dispatch queue with client-side navigations (see
 * CLAUDE.md's Loading feedback section) — polling one via `router.refresh()`
 * every 2.5s used to queue up behind a user's own nav clicks, which was
 * the actual cause of reported "lag flipping between tabs" while a sync
 * was running. A plain `fetch()` to a Route Handler runs on its own
 * connection, entirely outside that queue.
 *
 * Every wallet's own job columns are returned at once (not just one) —
 * JobPollerProvider is mounted once in the root layout and doesn't know
 * which wallet's buttons happen to be on screen, and reading a handful of
 * text/timestamp columns for every active wallet is still far cheaper
 * than one full page render.
 */
export async function GET() {
  const user = await getUser();
  if (!user) {
    return Response.json({ wallets: [], priceRefresh: null, tokenRegistry: null });
  }

  const db = await userDb();
  const [walletsResult, priceRefreshResult, tokenRegistryResult] = await Promise.all([
    db
      .from("wallets")
      .select(
        "id, last_refresh_status, sync_started_at, tx_sync_status, tx_sync_started_at, exchange_sync_status, exchange_sync_started_at",
      )
      .eq("active", true),
    // phases (per-lane coingecko/jupiter/hyperliquid/coinbase running/
    // done/error + elapsed ms — written by wallets/actions.ts's
    // runPriceRefresh) is read here too, not just status/started_at: it's
    // what lets JobPoller.tsx refresh the page as each lane finishes,
    // rather than only once the whole row's status flips — see that
    // file's own doc comment.
    serviceDb().from("price_refresh_state").select("status, started_at, phases").eq("id", 1).maybeSingle(),
    serviceDb().from("token_registry_state").select("status, started_at").eq("id", 1).maybeSingle(),
  ]);

  if (walletsResult.error) {
    return Response.json({ error: walletsResult.error.message }, { status: 500 });
  }

  return Response.json({
    wallets: walletsResult.data ?? [],
    priceRefresh: priceRefreshResult.data ?? null,
    tokenRegistry: tokenRegistryResult.data ?? null,
  });
}
