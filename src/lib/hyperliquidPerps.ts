// How a Hyperliquid perps account's value is split into rows, so the rows add
// up to the account's value exactly once. The account's value (accountValue)
// is withdrawable cash plus the margin held in open positions; each position
// row carries its own margin, so the "Perps Available" row is only what is
// left over — never the whole non-withdrawable part, which counted every
// position's margin twice (+$4,677 on one wallet vs DeBank, 2026-09-25). Pure.

import type { AdapterHolding } from "./adapters/types.ts";
import { stablecoinFallbackUsd } from "./stablecoinFallback.ts";
import { hyperliquidTpsl, type HyperliquidOrder } from "./tpsl.ts";

/** Account value not already shown as withdrawable cash or position margin
 * (usually ~0); null when there's nothing meaningful left (under a cent, or
 * negative from rounding). */
export function perpsUnallocatedUsd(accountValue: number, withdrawable: number, positionMargins: readonly number[]): number | null {
  if (!Number.isFinite(accountValue)) return null;
  const allocated = (Number.isFinite(withdrawable) ? withdrawable : 0) + positionMargins.filter(Number.isFinite).reduce((s, m) => s + m, 0);
  const rest = accountValue - allocated;
  return rest >= 0.01 ? rest : null;
}

export interface PerpPositionState {
  coin: string;
  szi: string;
  entryPx: string;
  liquidationPx: string | null;
  unrealizedPnl: string;
  marginUsed: string;
  leverage: { type: string; value: number };
  /** A fraction (×100 for a percentage). */
  returnOnEquity: string;
}

export interface PerpAccountState {
  /** Whole account: cross equity plus every isolated position's margin. */
  marginSummary: { accountValue: string };
  crossMarginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: { type: string; position: PerpPositionState }[];
}

/**
 * One Hyperliquid perp market's account as rows: withdrawable collateral,
 * the rest of the account value not in a position ("Available"), and each
 * open position at its margin, with PnL as detail — the rows add up to the
 * account value once. Used for the main market and for every HIP-3 market
 * (builder-deployed, e.g. tradeXYZ "xyz"), each of which holds its own margin
 * in its own collateral (USDC, USDH, USDe, USDT0). `market` is null for the
 * main market; for a HIP-3 one its label prefixes the rows' labels (position
 * tickers already carry the market, "xyz:TSLA"). Amounts are in the
 * collateral; they're dollars only when it's a listed stablecoin, else the
 * row stays unpriced (never valued 1:1 by assumption).
 */
export function perpAccountRows(
  state: PerpAccountState,
  collateral: string,
  market: { label: string } | null,
  /** The market's open orders, for each position's TP/SL; null = not read. */
  orders: readonly HyperliquidOrder[] | null = null,
): AdapterHolding[] {
  const base = { contract: null, category: "defi" as const, chain: "hyperliquid", icon_url: null, protocol: "Hyperliquid", protocol_url: null };
  const label = (what: string) => (market ? `${market.label} · ${what}` : `Perps ${what}`);
  const rows: AdapterHolding[] = [];
  const withdrawable = Number(state.withdrawable);
  if (Number.isFinite(withdrawable) && withdrawable > 0) {
    rows.push({ ...base, ticker: collateral, qty: withdrawable, usd_override: stablecoinFallbackUsd(collateral, withdrawable), protocol_section: "Deposit", display_label: label("Withdrawable") });
  }
  const open = state.assetPositions.filter(({ position }) => Number(position.szi) !== 0);
  // The WHOLE account's value (marginSummary), not cross-margin's alone:
  // every position's margin is subtracted, isolated ones included, so the
  // cross figure left accounts with isolated positions short (a HIP-3
  // trader's rows came to $4,563 of a $5,492 account, 2026-09-26).
  const available = perpsUnallocatedUsd(Number(state.marginSummary.accountValue), withdrawable, open.map(({ position }) => Number(position.marginUsed)));
  if (available !== null) {
    rows.push({ ...base, ticker: collateral, qty: available, usd_override: stablecoinFallbackUsd(collateral, available), protocol_section: "Deposit", display_label: label("Available") });
  }
  for (const { position } of open) {
    const size = Number(position.szi);
    const margin = Number(position.marginUsed);
    if (!Number.isFinite(size) || !Number.isFinite(margin)) continue;
    const pnl = Number(position.unrealizedPnl);
    const liq = position.liquidationPx !== null ? Number(position.liquidationPx) : null;
    const roe = Number(position.returnOnEquity);
    rows.push({
      ...base,
      ticker: `${position.coin}-PERP`,
      qty: Math.abs(size),
      usd_override: stablecoinFallbackUsd(collateral, margin),
      protocol_section: "Perpetuals",
      display_label: market ? market.label : null,
      position_side: size > 0 ? "long" : "short",
      position_tpsl: orders ? hyperliquidTpsl(orders, position.coin, size > 0 ? "long" : "short") : null,
      position_leverage: Number.isFinite(position.leverage?.value) ? position.leverage.value : null,
      position_entry_price: Number.isFinite(Number(position.entryPx)) ? Number(position.entryPx) : null,
      position_liquidation_price: liq !== null && Number.isFinite(liq) ? liq : null,
      position_pnl_usd: Number.isFinite(pnl) ? pnl : 0,
      position_pnl_percent: Number.isFinite(roe) ? roe * 100 : null,
    });
  }
  return rows;
}
