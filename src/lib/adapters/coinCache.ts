import "server-only";
import { serviceDb } from "../supabase";
import { fetchMarketsByIds } from "./coingecko";
import { splitByFreshness, SYNC_PRICE_MAX_AGE_MS } from "../priceCache";

// coin_cache: USD prices by CoinGecko coin id, shared by every sync in a
// run (see priceCache.ts). Native coins (ETH on ~12 chains per EVM wallet
// used to be one CoinGecko call per chain per wallet) and Cosmos tokens.

// Concurrent callers in one server instance share one fetch per id.
const inflight = new Map<string, Promise<number | null>>();

/** id -> USD (null = CoinGecko has no price), from coin_cache when fetched
 * within maxAgeMs, else one batched CoinGecko call for the rest. A cache
 * read/write failure falls back to fetching; a fetch failure throws. */
export async function cachedCoinPrices(ids: string[], maxAgeMs = SYNC_PRICE_MAX_AGE_MS): Promise<Map<string, number | null>> {
  const distinct = [...new Set(ids)];
  const out = new Map<string, number | null>();
  if (distinct.length === 0) return out;

  const db = serviceDb();
  const { data } = await db.from("coin_cache").select("coingecko_id, usd, usd_at").in("coingecko_id", distinct);
  const row = new Map(((data ?? []) as { coingecko_id: string; usd: number | string | null; usd_at: string | null }[]).map((r) => [r.coingecko_id, r]));
  const { fresh, stale } = splitByFreshness(distinct, (id) => row.get(id)?.usd_at, Date.now(), maxAgeMs);
  for (const id of fresh) {
    const usd = row.get(id)!.usd;
    out.set(id, usd === null ? null : Number(usd));
  }

  const toFetch = stale.filter((id) => !inflight.has(id));
  if (toFetch.length > 0) {
    const batch = fetchMarketsByIds(toFetch).then(async (markets) => {
      const byId = new Map(markets.map((m) => [m.id, m.price]));
      const usdAt = new Date().toISOString();
      await db
        .from("coin_cache")
        .upsert(toFetch.map((id) => ({ coingecko_id: id, usd: byId.get(id) ?? null, usd_at: usdAt, updated_at: usdAt })), { onConflict: "coingecko_id" })
        .then(({ error }) => error && console.warn(`[coinCache] save failed: ${error.message}`));
      return byId;
    });
    for (const id of toFetch) {
      const p = batch.then((byId) => byId.get(id) ?? null);
      inflight.set(id, p);
      void p.catch(() => {}).finally(() => inflight.delete(id));
    }
  }
  for (const id of stale) out.set(id, await inflight.get(id)!);
  return out;
}
