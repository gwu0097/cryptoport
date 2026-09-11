"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getActiveWalletsWithHoldings } from "@/lib/queries";
import { backfillPriceHistory } from "@/lib/priceHistory";

/**
 * Explicit, user-triggered fetch of historical prices for every currently
 * held token that isn't cached yet (see priceHistory.ts — this is
 * deliberately not something that runs on page load). Safe to click again
 * later: only still-uncached tokens are re-fetched.
 *
 * The actual fetching (up to ~4 minutes, spaced out to respect CoinGecko's
 * free-tier rate limit) runs inside after() rather than being awaited
 * directly — same pattern wallets/actions.ts's syncWalletHoldings already
 * uses for its own slow background work. Next dispatches Server Actions
 * one at a time per client (see node_modules/next/dist/docs/.../
 * server-actions.md's "Sequential dispatch on the client"), so awaiting
 * the whole loop here would leave the submit button's pending state (and,
 * per that same doc, any other action the user tries to trigger next)
 * stuck for as long as the backfill takes — exactly the "click doesn't do
 * anything" freeze this fixes. after() lets this action return almost
 * immediately; the actual coverage update just needs a revisit/refresh of
 * /analytics once the background work finishes.
 */
export async function backfillHistoryAction() {
  await requireUser();
  const wallets = await getActiveWalletsWithHoldings();
  const holdings = wallets.flatMap((w) => w.holdings);

  after(async () => {
    await backfillPriceHistory(holdings);
    revalidatePath("/analytics");
  });
}
