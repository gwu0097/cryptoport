import "server-only";
import { serviceDb } from "../supabase";
import { contractKey, resolvePriceKey, venueKey, type KeyInput, type KeyMaps } from "../assetIdentity";

// Loads the lookup tables assetIdentity.ts resolves price keys from, for just
// the rows at hand: token_registry (CoinGecko's contract -> coin map, the
// contracts present), asset_contracts overrides, and the per-venue ticker
// map. A lookup failure throws: a sync must not save rows with keys missing
// because a table couldn't be read (docs/pricing/PLAN.md).

const REGISTRY_CHAIN: Record<string, string> = { "solana-defi": "solana" };

/** Every row of a mapping table, paged in its primary-key order (a unique
 * sort, so pages never skip or repeat a row). */
async function readAll<T>(table: string, columns: string, key: [string, string]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await serviceDb().from(table).select(columns).order(key[0]).order(key[1]).range(from, from + 999);
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) return out;
  }
}

export async function loadKeyMaps(rows: KeyInput[]): Promise<KeyMaps> {
  const db = serviceDb();
  const byChain = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.chain || !r.contract) continue;
    const chain = REGISTRY_CHAIN[r.chain] ?? r.chain;
    const set = byChain.get(chain) ?? new Set<string>();
    set.add(r.contract.toLowerCase()); // token_registry stores every contract lowercase
    byChain.set(chain, set);
  }

  const registry = new Map<string, string>();
  for (const [chain, contracts] of byChain) {
    const list = [...contracts];
    for (let i = 0; i < list.length; i += 200) {
      const { data, error } = await db
        .from("token_registry")
        .select("contract, coingecko_id")
        .eq("chain_id", chain)
        .in("contract", list.slice(i, i + 200))
        .not("coingecko_id", "is", null);
      if (error) throw new Error(`Failed to read token_registry (${chain}): ${error.message}`);
      for (const r of data as { contract: string; coingecko_id: string }[]) registry.set(contractKey(chain, r.contract), r.coingecko_id);
    }
  }

  // Whole tables, paged: the API returns at most 1,000 rows per request,
  // and exchange_assets has more — an unpaged read silently dropped the
  // mappings past row 1,000 (Hyperliquid's USDC -> usd-coin, 2026-09-25).
  const [overrideRows, venueRows] = await Promise.all([
    readAll<{ chain: string; contract: string; price_key: string }>("asset_contracts", "chain, contract, price_key", ["chain", "contract"]),
    readAll<{ exchange: string; ticker: string; price_key: string }>("exchange_assets", "exchange, ticker, price_key", ["exchange", "ticker"]),
  ]);
  const overrides = new Map(overrideRows.map((r) => [contractKey(r.chain, r.contract), r.price_key]));
  const venues = new Map(venueRows.map((r) => [venueKey(r.exchange, r.ticker), r.price_key]));
  return { registry, overrides, venues };
}

/** Each row with its price_key set, for rows written under `source`
 * (docs/pricing/PLAN.md phase 1: written alongside today's pricing; nothing
 * reads it yet). */
export async function withPriceKeys<T extends Omit<KeyInput, "source">>(
  rows: T[],
  source: string,
): Promise<(T & { price_key: string | null })[]> {
  if (rows.length === 0) return [];
  const inputs: KeyInput[] = rows.map((r) => ({ ...r, source }));
  const maps = await loadKeyMaps(inputs);
  return rows.map((r, i) => ({ ...r, price_key: resolvePriceKey(inputs[i], maps) }));
}
