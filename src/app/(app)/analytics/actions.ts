"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getActiveWalletsWithHoldings } from "@/lib/queries";
import { backfillPriceHistory } from "@/lib/priceHistory";

/**
 * Explicit, user-triggered fetch of historical prices for every currently
 * held token that isn't cached yet (see priceHistory.ts — this is deliberately
 * not something that runs on page load, since it can mean dozens of
 * CoinGecko calls the first time). Safe to click again later: only
 * still-uncached tokens are re-fetched.
 */
export async function backfillHistoryAction() {
  await requireUser();
  const wallets = await getActiveWalletsWithHoldings();
  const holdings = wallets.flatMap((w) => w.holdings);
  await backfillPriceHistory(holdings);
  revalidatePath("/analytics");
}
