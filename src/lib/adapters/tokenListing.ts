import "server-only";
import { serviceDb } from "../supabase";

/**
 * Which of `contracts` CoinGecko lists on this chain — read from
 * token_registry (CoinGecko's own contract → coin list, refreshed weekly), not
 * asked of CoinGecko. The transaction sources use it to hide airdrop spam
 * (spam is never listed); asking CoinGecko's token_price endpoint instead cost
 * CoinGecko calls on every transaction sync of every chain. Throws on a read
 * failure (callers fail open: no filter rather than hiding everything).
 */
export async function listedContracts(chainId: string, contracts: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(contracts.map((c) => c.toLowerCase()))];
  const out = new Set<string>();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data, error } = await serviceDb()
      .from("token_registry")
      .select("contract")
      .eq("chain_id", chainId)
      .not("coingecko_id", "is", null)
      .in("contract", wanted.slice(i, i + 200));
    if (error) throw new Error(`token list read: ${error.message}`);
    for (const r of data as { contract: string }[]) out.add(r.contract.toLowerCase());
  }
  return out;
}
