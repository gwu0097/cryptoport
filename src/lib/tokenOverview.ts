// The token drawer's Overview (owner 2026-10-09: click a token anywhere — which
// of my wallets hold it, its contracts, a quick chart, without going around
// the site). Pure: the endpoint (api/token) reads, this shapes the answer.

import { valueHolding, type PriceMap } from "./valuation.ts";
import type { HoldingSource } from "./types.ts";
import type { CoinContract } from "./coinContracts.ts";

/** A holding of the coin, with its wallet (holdings joined to wallets). */
export interface TokenHoldingRow {
  ticker: string;
  qty: number | string | null;
  usd_override: number | string | null;
  source: HoldingSource;
  price_key: string | null;
  protocol: string | null;
  walletId: string;
  walletName: string;
  chainName: string;
}

export interface TokenStats {
  usd: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  marketCap: number | null;
  volume24h: number | null;
  updatedAt: string | null;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
}

export interface TokenOverview {
  key: string;
  ticker: string;
  name: string | null;
  iconUrl: string | null;
  stats: TokenStats | null;
  position: {
    totalQty: number | null;
    /** Sum of the priced rows; null when none is priced. */
    totalUsd: number | null;
    unpriced: number;
    /** One line per holding, largest first. */
    rows: { walletId: string; walletName: string; chainName: string; qty: number | null; usd: number | null; protocol: string | null }[];
  };
  contracts: CoinContract[];
  watchlists: { id: string; name: string }[];
  /** The TradingView ticker when TradingView lists the coin; otherwise our own
   * daily closes (oldest first) to chart. */
  chart: { tradingView: string | null; closes: [string, number][] };
}

const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function buildTokenOverview(input: {
  key: string;
  holdings: readonly TokenHoldingRow[];
  prices: PriceMap;
  stats: TokenStats | null;
  contracts: readonly CoinContract[];
  watchlists: readonly { id: string; name: string }[];
  tradingView: string | null;
  closes: readonly [string, number][];
}): TokenOverview {
  const rows = input.holdings
    .map((h) => {
      const v = valueHolding({ ticker: h.ticker, qty: h.qty, usd_override: h.usd_override, source: h.source, price_key: h.price_key }, input.prices);
      return { walletId: h.walletId, walletName: h.walletName, chainName: h.chainName, qty: num(h.qty), usd: v.kind === "priced" ? v.usd : null, protocol: h.protocol };
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const priced = rows.filter((r) => r.usd !== null);
  const qtys = rows.map((r) => r.qty);
  const ticker = input.stats?.symbol?.toUpperCase() ?? input.holdings[0]?.ticker ?? input.key;
  return {
    key: input.key,
    ticker,
    name: input.stats?.name ?? null,
    iconUrl: input.stats?.imageUrl ?? null,
    stats: input.stats,
    position: {
      totalQty: rows.length && qtys.every((q) => q !== null) ? qtys.reduce((s, q) => s + (q as number), 0) : null,
      totalUsd: priced.length ? priced.reduce((s, r) => s + (r.usd as number), 0) : null,
      unpriced: rows.length - priced.length,
      rows,
    },
    contracts: [...input.contracts],
    watchlists: [...input.watchlists],
    chart: { tradingView: input.tradingView, closes: input.tradingView ? [] : [...input.closes] },
  };
}
