import type { NextRequest } from "next/server";
import { capturePortfolioSnapshots } from "@/lib/snapshots";

// Iterates every user with at least one active wallet in a single pass —
// cheap per user (no per-user network calls, just in-memory aggregate()
// over already-fetched holdings/prices) — so 60s is generous headroom, not
// tight like refreshTokenRegistryAction/refreshPricesAction's 300s (those
// make real per-token network calls).
export const maxDuration = 60;

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
  return Response.json(result);
}
