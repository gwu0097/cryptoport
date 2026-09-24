import type { NextRequest } from "next/server";
import { capturePortfolioSnapshots } from "@/lib/snapshots";
import { refreshLiquidStakingTokensIfStale } from "@/lib/adapters/liquidStakingRegistry";

// Iterates every user with at least one active wallet in a single pass —
// cheap per user (no per-user network calls, just in-memory aggregate()
// over already-fetched holdings/prices) — so 60s is generous headroom, not
// tight like refreshTokenRegistryAction/refreshPricesAction's 300s (those
// make real per-token network calls).
// 120, not 60: the weekly liquid staking token refresh below (~10
// CoinGecko calls, with backoff on a 429) rides along with this daily run.
export const maxDuration = 120;

/**
 * Vercel Cron's only trigger for this route (see vercel.json) — daily. When
 * a CRON_SECRET env var is set, Vercel automatically attaches it as this
 * exact Authorization header on the request it makes; nothing else should
 * ever be able to produce it, so this is sufficient auth for a route that
 * only ever writes aggregate totals, never anything a user submitted.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await capturePortfolioSnapshots();
  // Weekly (it's a no-op while the table is under a week old); its own
  // failure never fails the snapshot run.
  const liquidStaking = await refreshLiquidStakingTokensIfStale().catch((e: Error) => `error: ${e.message}`);
  return Response.json({ ...result, liquidStaking });
}
