import type { NextRequest } from "next/server";
import { capturePortfolioSnapshots } from "@/lib/snapshots";
import { refreshAssetPricesIfOlderThan } from "@/lib/adapters/assetPrices";

// Iterates every user with at least one active wallet in a single pass —
// cheap per user (no per-user network calls, just in-memory aggregate()
// over already-fetched holdings/prices) — so 60s is generous headroom, not
// tight like refreshTokenRegistryAction/refreshPricesAction's 300s (those
// make real per-token network calls).
// The liquid staking list's weekly refresh moved to the token list's own
// cron (/api/cron/token-registry, 2026-09-25).
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

  // Prices first (decided 2026-09-25, docs/pricing/PLAN.md): a snapshot on
  // a day nobody opened the app would otherwise record stale values into
  // history. Only when the newest price is older than 6h (~2 calls/day).
  const prices = await refreshAssetPricesIfOlderThan(6 * 60 * 60 * 1000, "snapshot").catch((e: Error) => `error: ${e.message}`);
  const result = await capturePortfolioSnapshots();
  return Response.json({ ...result, prices });
}
