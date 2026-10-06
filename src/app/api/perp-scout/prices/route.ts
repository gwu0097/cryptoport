import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { fetchMids } from "@/lib/adapters/hyperliquidScout";

export const dynamic = "force-dynamic";

/** Perp Scout's Refresh prices: every perp's current mid from Hyperliquid
 * (one allMids call, weight 2). Not stored — the page swaps its scan-time
 * marks for these until the next load. */
export async function POST(): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Sign in to refresh prices" }, { status: 401 });
  const guard = await guardUser("perpScoutPrices", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  try {
    return Response.json({ at: Date.now(), mids: await fetchMids() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
