import type { NextRequest } from "next/server";
import { refreshCorrelationUniverse } from "@/lib/correlationUniverse";

// Real per-coin network calls (see correlationUniverse.ts's own TIME_BUDGET_MS
// comment) — same ceiling as refreshTokenRegistryAction/refreshPricesAction,
// not the 60s the aggregate-only snapshot cron gets away with.
export const maxDuration = 300;

/**
 * Vercel Cron's only trigger for this route (see vercel.json) — daily, same
 * CRON_SECRET bearer-auth pattern as /api/cron/snapshot. Keeps
 * cryptoport.coin_hourly_series warm for Trend Finder's correlation-based
 * peer ranking (see correlationUniverse.ts) — this route only ever writes
 * app-wide reference data, never anything a user submitted.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await refreshCorrelationUniverse();
  return Response.json(result);
}
