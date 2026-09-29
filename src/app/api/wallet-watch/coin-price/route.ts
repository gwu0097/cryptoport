import { getUser } from "@/lib/auth";
import { ensureAssetPrices } from "@/lib/adapters/assetPrices";
import { getMarketFor } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * One coin's latest price and market cap — the refresh button on a Wallet
 * Watch activity row (owner 2026-09-29: "super light, just that one
 * token"). One call to the coin's source (Jupiter or CoinGecko), skipped
 * when it was priced or tried in the last minute, then one read. Stored
 * like any price, so every page shows it after.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await getUser())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const { priceKey } = (await request.json().catch(() => ({}))) as { priceKey?: unknown };
  if (typeof priceKey !== "string" || priceKey.length > 120 || !/^[A-Za-z0-9:._-]+$/.test(priceKey)) {
    return Response.json({ error: "Unknown coin" }, { status: 400 });
  }
  try {
    await ensureAssetPrices([priceKey], "coin-refresh", 60_000);
    const { stats } = await getMarketFor([priceKey]);
    const s = stats.get(priceKey);
    return Response.json({ usd: s?.usd ?? null, marketCap: s?.marketCap ?? null, at: s?.updatedAt ?? null });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
