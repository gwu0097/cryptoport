import "server-only";
import { serviceDb } from "../supabase";
import { contractKey, resolvePriceKey, venueKey, type KeyInput, type KeyMaps } from "../assetIdentity";

// Loads the lookup tables assetIdentity.ts resolves price keys from, for just
// the rows at hand: token_registry (CoinGecko's contract -> coin map, the
// contracts present), asset_contracts overrides, and the per-venue ticker
// map. A lookup failure throws: a sync must not save rows with keys missing
// because a table couldn't be read (docs/pricing/PLAN.md).

const REGISTRY_CHAIN: Record<string, string> = { "solana-defi": "solana" };

export async function loadKeyMaps(rows: KeyInput[]): Promise<KeyMaps> {
  const db = serviceDb();
  const byChain = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.chain || !r.contract) continue;
    const chain = REGISTRY_CHAIN[r.chain] ?? r.chain;
    const set = byChain.get(chain) ?? new Set<string>();
    // token_registry stores EVM contracts lowercase; mints/types as-is.
    set.add(/^0x[0-9a-f]+$/i.test(r.contract) ? r.contract.toLowerCase() : r.contract);
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

  const [overridesRes, venuesRes] = await Promise.all([
    db.from("asset_contracts").select("chain, contract, price_key"),
    db.from("exchange_assets").select("exchange, ticker, price_key"),
  ]);
  if (overridesRes.error) throw new Error(`Failed to read asset_contracts: ${overridesRes.error.message}`);
  if (venuesRes.error) throw new Error(`Failed to read exchange_assets: ${venuesRes.error.message}`);
  const overrides = new Map(
    (overridesRes.data as { chain: string; contract: string; price_key: string }[]).map((r) => [contractKey(r.chain, r.contract), r.price_key]),
  );
  const venues = new Map(
    (venuesRes.data as { exchange: string; ticker: string; price_key: string }[]).map((r) => [venueKey(r.exchange, r.ticker), r.price_key]),
  );
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
