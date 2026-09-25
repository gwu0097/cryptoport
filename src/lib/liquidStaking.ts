// The Assets page's "Combine liquid staking tokens" view: a liquid staking
// (or restaking) token is folded into the row of the coin it stakes —
// weETH/stETH into ETH, MaticX/stMATIC into POL, jitoSOL/mSOL into SOL — so
// "how much ETH do I have" has one answer. Pure (no DB, no network).
//
// Which tokens are liquid staking tokens is CoinGecko's call, not a list in
// this repo: liquid_staking_tokens holds every member of CoinGecko's liquid
// staking categories (adapters/liquidStakingRegistry.ts refreshes it), so a
// newly listed one is picked up without a code change. The base coin comes
// from the category ("Liquid Staked ETH" → ETH) when CoinGecko has one for
// it, else from the token's symbol against the coins this portfolio holds
// (stATOM → ATOM, MaticX → MATIC). That inference only ever runs on tokens
// CoinGecko already classifies as liquid staking, and only picks a base the
// user actually holds or a coin-specific category named.
//
// Only the grouping changes. Every holding keeps its own valuation (a weETH
// is still worth its own price, not ETH's), so totals are identical with the
// toggle on or off. The merged row's quantity is in the base coin: its own
// balance plus each staked token's value at the base coin's price (≈, since a
// staked token trades near, not at, the base price). If any part can't be
// converted (no price), the quantity is unknown ("—"), never a partial sum.

import type { AssetGroup } from "./queries.ts";

export interface LiquidStakingToken {
  coingeckoId: string;
  symbol: string;
  /** From a coin-specific category ("Liquid Staked ETH"); null when the
   * token is only in CoinGecko's generic liquid staking categories. */
  baseSymbol: string | null;
}

/** "Liquid Staked ETH" / "Liquid Restaked SOL" → "ETH" / "SOL"; null for
 * the generic ones ("Liquid Staking Tokens") and anything else. */
export function categoryBase(name: string): string | null {
  const m = name.trim().match(/^Liquid (?:Re)?staked ([A-Za-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : null;
}

// A renamed coin whose staking tokens still carry the old name. This is a
// fact about the base coin (Polygon's MATIC → POL migration), not a list of
// staking tokens.
const RENAMED: Record<string, string> = { MATIC: "POL" };

/** The held coin a generic liquid staking token's symbol is built from: a
 * short prefix (st, stk, d, milk, wb, s…) before it, or a one-or-two
 * character suffix (x, 2) after it. Longest match wins; tickers under three
 * characters never match (too easy to find inside an unrelated symbol). */
export function inferBase(symbol: string, candidates: Iterable<string>): string | null {
  const s = symbol.toUpperCase();
  let best: string | null = null;
  for (const raw of candidates) {
    const t = raw.toUpperCase();
    if (t.length < 3 || t === s || (best && best.length >= t.length)) continue;
    const prefix = s.endsWith(t) ? s.slice(0, -t.length) : null;
    const suffix = s.startsWith(t) ? s.slice(t.length) : null;
    if ((prefix !== null && /^[A-Z]{1,4}$/.test(prefix)) || (suffix !== null && /^[A-Z0-9]{1,2}$/.test(suffix))) best = t;
  }
  return best;
}

/** tickerKey of each liquid staking group → tickerKey of its base coin.
 * Symbols are matched on each row's display symbol (`ticker`), and the base
 * is returned as its row key — rows are keyed by coin (price_key) since
 * pricing phase 2, so a key ("cosmos") and its symbol ("ATOM") differ. A
 * base coin no row holds is returned as its symbol (a new row for it). */
export function resolveBases(groups: AssetGroup[], tokens: LiquidStakingToken[]): Map<string, string> {
  const byId = new Map(tokens.map((t) => [t.coingeckoId, t]));
  const bySymbol = new Map<string, LiquidStakingToken[]>();
  for (const t of tokens) {
    const k = t.symbol.toUpperCase();
    bySymbol.set(k, [...(bySymbol.get(k) ?? []), t]);
  }
  const symbolOf = (g: AssetGroup) => g.ticker.toUpperCase();

  const matched = new Map<string, LiquidStakingToken[]>();
  for (const g of groups) {
    const byIdHit = g.coingeckoId ? byId.get(g.coingeckoId) : undefined;
    const hits = byIdHit ? [byIdHit] : (bySymbol.get(symbolOf(g)) ?? []);
    if (hits.length > 0) matched.set(g.tickerKey, hits);
  }
  // Coins a generic token can fold into: held, and not themselves staking
  // tokens (wstETH must find ETH, not stETH). Symbol -> the row holding it.
  const keyBySymbol = new Map<string, string>();
  for (const g of groups) if (!matched.has(g.tickerKey) && !keyBySymbol.has(symbolOf(g))) keyBySymbol.set(symbolOf(g), g.tickerKey);
  const held = [...keyBySymbol.keys()];
  const renamed = (b: string) => (!keyBySymbol.has(b) && RENAMED[b] && keyBySymbol.has(RENAMED[b]) ? RENAMED[b] : b);
  const symbolByKey = new Map(groups.map((g) => [g.tickerKey, symbolOf(g)]));

  const out = new Map<string, string>();
  for (const [key, hits] of matched) {
    // Candidates held by symbol only when every same-symbol token agrees.
    const bases = new Set(
      hits.map((t) => {
        const b = t.baseSymbol ?? inferBase(t.symbol, [...held, ...Object.keys(RENAMED)]);
        return b ? renamed(b) : null;
      }),
    );
    const [base] = bases;
    if (bases.size !== 1 || !base || base === symbolByKey.get(key)) continue;
    out.set(key, keyBySymbol.get(base) ?? base);
  }
  return out;
}

function emptyGroup(ticker: string): AssetGroup {
  return {
    tickerKey: ticker,
    ticker,
    iconUrl: null,
    totalQty: 0,
    total: 0,
    unpricedCount: 0,
    price: null,
    change24h: null,
    change1h: null,
    change7d: null,
    change30d: null,
    marketCap: null,
    coingeckoId: null,
    holdings: [],
  };
}

/** `bases` from resolveBases. Same array back when nothing combines. */
export function consolidateLiquidStaking(groups: AssetGroup[], bases: Map<string, string>): AssetGroup[] {
  const byKey = new Map(groups.map((g) => [g.tickerKey, g]));
  const merged = new Map<string, AssetGroup[]>();
  for (const g of groups) {
    const base = bases.get(g.tickerKey);
    if (!base) continue;
    merged.set(base, [...(merged.get(base) ?? []), g]);
  }
  if (merged.size === 0) return groups;

  const out: AssetGroup[] = [];
  for (const g of groups) {
    if (bases.has(g.tickerKey)) continue;
    const staked = merged.get(g.tickerKey);
    out.push(staked ? combine(g, staked) : g);
  }
  // A staked token held without its base coin still gets a base-coin row.
  for (const [base, staked] of merged) {
    if (!byKey.has(base)) out.push(combine(emptyGroup(base), staked));
  }
  return out.sort((a, b) => b.total - a.total);
}

function combine(base: AssetGroup, staked: AssetGroup[]): AssetGroup {
  // Base-coin equivalent: base qty + each staked holding's value / base price.
  let qty: number | null = base.totalQty;
  for (const h of staked.flatMap((s) => s.holdings)) {
    if (qty === null || base.price === null || base.price <= 0 || h.valuation.kind !== "priced") {
      qty = null;
      break;
    }
    qty += h.valuation.usd / base.price;
  }
  return {
    ...base,
    totalQty: qty,
    total: base.total + staked.reduce((s, g) => s + g.total, 0),
    unpricedCount: base.unpricedCount + staked.reduce((s, g) => s + g.unpricedCount, 0),
    holdings: [...base.holdings, ...staked.flatMap((s) => s.holdings)],
    combinedTickers: staked.map((s) => s.ticker),
  };
}
