import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const BALANCES_URL = "https://lite-api.jup.ag/ultra/v1/balances";
// Not the endpoint originally specified (price/v3) — that one doesn't return
// a symbol at all, only usdPrice/liquidity, and this project needs a human
// ticker for display and as the prices-table key. tokens/v2/search returns
// symbol + usdPrice + liquidity together; spot-checked its price/liquidity
// against price/v3 for the same mints and they matched exactly (same
// underlying feed), so this replaces price/v3 rather than adding a second
// call.
const TOKEN_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SEARCH_BATCH_SIZE = 100;
const TOKEN_USD_FLOOR = 5;
// Not specified by the user (only "use liquidity as the spam filter"
// qualitatively) — chosen to clear the one confirmed pump-and-dump example
// ($324 position, $17,019 liquidity) with real margin. Tunable.
const LIQUIDITY_FLOOR = 100_000;

interface JupiterBalance {
  amount: string;
  uiAmount: number;
  isFrozen: boolean;
}

export interface JupiterTokenInfo {
  id: string;
  symbol?: string;
  usdPrice?: number;
  liquidity?: number;
}

const HEADERS = { "User-Agent": "cryptoport/1.0" };

async function fetchBalances(address: string): Promise<Record<string, JupiterBalance>> {
  const res = await fetchWithRetry(`${BALANCES_URL}/${address}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Jupiter balances failed: HTTP ${res.status}`);
  return res.json();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Exported for reuse by prices.ts's Jupiter-fallback pricing path. */
export async function fetchTokenInfo(mints: string[]): Promise<Map<string, JupiterTokenInfo>> {
  if (mints.length === 0) return new Map();
  const info = new Map<string, JupiterTokenInfo>();
  for (const batch of chunk(mints, SEARCH_BATCH_SIZE)) {
    const url = `${TOKEN_SEARCH_URL}?query=${encodeURIComponent(batch.join(","))}`;
    const res = await fetchWithRetry(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Jupiter tokens/v2/search failed: HTTP ${res.status}`);
    const results: JupiterTokenInfo[] = await res.json();
    for (const t of results) info.set(t.id, t);
  }
  return info;
}

/**
 * Every SPL balance the wallet holds, priced where Jupiter has a market for
 * it. A holding Jupiter has a *name* for but no live price is still
 * included as unpriced — "no price" is a real, visible state elsewhere in
 * this app, not silence, and a named-but-unpriced token (e.g. real but
 * thinly traded) is still worth knowing about. A holding with no metadata
 * at all — no symbol, nothing — is dropped entirely rather than shown as a
 * bare mint address: in practice this is almost always an NFT (amount=1 is
 * the classic tell) or a dead/never-indexed mint, and a raw base58 string
 * with no name and no price tells the user nothing they can act on.
 * Native SOL comes back under the literal key "SOL" and is mapped to the
 * wrapped-SOL mint only for the metadata/price lookup — the stored ticker
 * stays "SOL".
 */
export async function fetchJupiterHoldings(address: string): Promise<AdapterHolding[]> {
  const balances = await fetchBalances(address);

  const entries = Object.entries(balances).filter(([, b]) => b.uiAmount > 0);
  const mints = entries.map(([key]) => (key === "SOL" ? WRAPPED_SOL_MINT : key));
  const tokenInfo = await fetchTokenInfo(mints);

  const holdings: AdapterHolding[] = [];
  for (const [key, balance] of entries) {
    const mint = key === "SOL" ? WRAPPED_SOL_MINT : key;
    const info = tokenInfo.get(mint);
    const usd = info?.usdPrice != null ? info.usdPrice * balance.uiAmount : null;

    if (usd !== null) {
      if (usd <= TOKEN_USD_FLOOR) continue;
      if ((info?.liquidity ?? 0) < LIQUIDITY_FLOOR) continue;
    } else if (key !== "SOL" && !info?.symbol) {
      continue; // no name, no price — nothing to show, see doc comment above
    }

    holdings.push({
      ticker: key === "SOL" ? "SOL" : (info?.symbol ?? key),
      qty: balance.uiAmount,
      usd_override: null,
      contract: key === "SOL" ? null : key,
      category: "token",
      chain: "solana",
    });
  }

  return holdings;
}
