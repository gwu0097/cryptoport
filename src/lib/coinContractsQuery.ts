import "server-only";
import { serviceDb } from "./supabase";
import { copyableContracts, ownContract, type CoinContract } from "./coinContracts";

/**
 * Each coin's copyable token addresses (coinContracts.ts): a `jup:` coin's
 * own mint, else its contracts in token_registry (Solana/Sui as written) — one request for up
 * to 200 coins (the Watchlist reads its list at once). A failure leaves
 * the rows without a copy button, never fails the page.
 */
export async function getCoinContracts(coinKeys: readonly string[]): Promise<Map<string, CoinContract[]>> {
  const out = new Map<string, CoinContract[]>();
  const lookup: string[] = [];
  for (const key of new Set(coinKeys)) {
    const own = ownContract(key);
    if (own) out.set(key, [own]);
    else if (!key.includes(":")) lookup.push(key);
  }
  for (let i = 0; i < lookup.length; i += 200) {
    const { data, error } = await serviceDb().from("token_registry").select("coingecko_id, chain_id, contract, contract_exact").in("coingecko_id", lookup.slice(i, i + 200));
    if (error) {
      console.error(`[coin-contracts] token_registry: ${error.message}`);
      break;
    }
    const byCoin = new Map<string, { chain_id: string; contract: string; contract_exact: string | null }[]>();
    for (const r of (data ?? []) as { coingecko_id: string; chain_id: string; contract: string; contract_exact: string | null }[]) byCoin.set(r.coingecko_id, [...(byCoin.get(r.coingecko_id) ?? []), r]);
    for (const [id, rows] of byCoin) {
      const list = copyableContracts(rows);
      if (list.length) out.set(id, list);
    }
  }
  return out;
}
