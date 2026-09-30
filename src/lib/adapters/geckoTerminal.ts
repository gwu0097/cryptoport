import "server-only";
import { fetchWithRetry } from "./http";

// GeckoTerminal's public token API (no key; 30 calls a minute): an EVM
// coin's liquidity (all its pools) and market cap, up to 30 coins a call.
// Used once per live delivery that opens a Wallet Watch position on an EVM
// chain (entryLiquidity.ts) — the entry's liquidity, and the coin's market
// cap for its alert. Checked live 2026-09-30 on Ethereum and Robinhood
// Chain (ZZZ, BUCKET, USO).

/** Our chain ids (holdings vocabulary) → GeckoTerminal's network ids. */
const NETWORK: Readonly<Record<string, string>> = { eth: "eth", arb: "arbitrum", base: "base", bsc: "bsc", matic: "polygon_pos", op: "optimism", avax: "avax", rbh: "robinhood" };
const BATCH = 30;

export interface TokenMarket {
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
}

const num = (v: unknown) => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Each contract's market (lowercased keys); a chain GeckoTerminal doesn't
 * know is skipped. Throws on a failed call (the caller shows none). */
export async function fetchTokenMarkets(chain: string, contracts: readonly string[]): Promise<Map<string, TokenMarket>> {
  const out = new Map<string, TokenMarket>();
  const network = NETWORK[chain];
  if (!network || contracts.length === 0) return out;
  const unique = [...new Set(contracts.map((c) => c.toLowerCase()))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const res = await fetchWithRetry(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/multi/${unique.slice(i, i + BATCH).join(",")}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`GeckoTerminal: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { attributes?: Record<string, unknown> }[] };
    for (const t of body.data ?? []) {
      const a = t.attributes ?? {};
      if (typeof a.address !== "string") continue;
      out.set(a.address.toLowerCase(), { liquidityUsd: num(a.total_reserve_in_usd), marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd), priceUsd: num(a.price_usd) });
    }
  }
  return out;
}
