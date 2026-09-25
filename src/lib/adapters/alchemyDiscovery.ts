import "server-only";
import { fetchWithRetry } from "./http";

// Which token contracts a wallet holds on a chain, from Alchemy's indexer
// (alchemy_getTokenBalances) — finds tokens CoinGecko doesn't list, and lets a
// sync read only what the wallet holds instead of every listed token
// (docs/sync/PLAN.md D1). All-or-nothing: any failure throws, and the caller
// falls back to the registry scan for that chain (D4). Pages are 100 tokens,
// sequential; a wallet that needs more than DISCOVERY_MAX_PAGES on one chain
// (1,000 tokens — airdrop-heavy addresses) is reported `capped` and the caller
// falls back the same way (D1b). ~20 CU per call on the free tier.

export const DISCOVERY_MAX_PAGES = 10;

export interface Discovery {
  contracts: string[]; // lowercase, non-zero balance
  pages: number;
  capped: boolean;
}

export async function discoverAlchemyTokens(network: string, owner: string): Promise<Discovery> {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY not set");
  const url = `https://${network}.g.alchemy.com/v2/${key}`;
  const contracts = new Set<string>();
  let pageKey: string | undefined;
  let pages = 0;
  do {
    if (pages === DISCOVERY_MAX_PAGES) return { contracts: [...contracts], pages, capped: true };
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params: [owner, "erc20", ...(pageKey ? [{ pageKey }] : [])] }),
    });
    if (!res.ok) throw new Error(`Alchemy ${network}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { tokenBalances: { contractAddress: string; tokenBalance: string | null }[]; pageKey?: string };
      error?: { message?: string };
    };
    if (!body.result) throw new Error(`Alchemy ${network}: ${body.error?.message ?? "no result"}`);
    pages++;
    for (const t of body.result.tokenBalances) {
      if (t.tokenBalance && BigInt(t.tokenBalance) > BigInt(0)) contracts.add(t.contractAddress.toLowerCase());
    }
    pageKey = body.result.pageKey;
  } while (pageKey);
  return { contracts: [...contracts], pages, capped: false };
}
