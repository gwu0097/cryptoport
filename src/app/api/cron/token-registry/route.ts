import type { NextRequest } from "next/server";
import { refreshTokenRegistryIfStale, TOKEN_LIST_WEEKLY } from "@/lib/tokenRegistryRefresh";

// The token list's weekly refresh (see lib/tokenRegistryRefresh.ts) — its own
// cron because it takes ~80s, too long to ride along with the daily snapshot
// (maxDuration 120). Skips itself when a sync-triggered refresh already ran
// this week.
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await refreshTokenRegistryIfStale(TOKEN_LIST_WEEKLY);
  return Response.json({ tokenRegistry: result });
}
