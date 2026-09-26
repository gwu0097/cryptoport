// Aster (asterdex.com perps DEX, BNB Chain) account → holdings. Pure; the
// network part is adapters/aster.ts. Same shape as Hyperliquid and Lighter:
//  - Perpetuals: each open position valued at its margin (isolated: its
//    isolated wallet; cross: notional ÷ leverage), with side, leverage, entry,
//    and unrealized PnL as detail;
//  - Deposit: the account's stablecoin collateral plus unrealized PnL, less
//    what the positions' margin already shows ("Available") — so the rows add
//    up to the account's equity once (Binance-style: equity = wallet balance
//    + unrealized PnL); other collateral (ASTER, BNB, …) as its own coin rows;
//  - Staked / Rewards: staked ASTER and unclaimed staking rewards.
// Amounts arrive as strings or numbers. A position's symbol is "<BASE><QUOTE>"
// (BTCUSDT, ETHUSD1); its row is "<BASE>-PERP" with the symbol as `contract`
// (the key its mark price is stored under, perpPositions.ts).

import type { AdapterHolding } from "./adapters/types.ts";
import { perpsUnallocatedUsd } from "./hyperliquidPerps.ts";

export interface AsterPosition {
  symbol: string;
  collateral?: string;
  positionAmount: string;
  entryPrice: string;
  unrealizedProfit: string;
  notionalValue: string;
  markPrice?: string;
  leverage: number | string;
  isolated: boolean;
  isolatedWallet: string;
  positionSide?: string; // BOTH (one-way: sign of positionAmount) | LONG | SHORT
}

export interface AsterBalance {
  address: string;
  accountPrivacy?: string;
  perpAssets?: { asset: string; walletBalance: number | string }[];
  positions?: { tradingProduct: string; positions: AsterPosition[] }[];
  staking?: {
    totalStakedAmount?: number | string;
    totalUnclaimedRewards?: { asset: string; amount: number | string }[];
  } | null;
}

// Collateral Aster counts as dollars, and the CoinGecko coin each asset is
// (from token_registry's BNB Chain entries, 2026-09-26). An asset not listed
// here is still shown, unpriced — never valued 1:1 by assumption.
const STABLE = new Set(["USDT", "USDC", "USD1", "USDF"]);
export const ASTER_COINS: Readonly<Record<string, string>> = {
  USDT: "tether",
  USDC: "usd-coin",
  USD1: "usd1-wlfi",
  USDF: "astherus-usdf",
  ASTER: "aster-2",
  BNB: "binancecoin",
  ETH: "ethereum",
  BTC: "bitcoin",
};

const APP_URL = "https://www.asterdex.com/en/futures";
const num = (v: string | number | null | undefined) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};

function base(section: string, label: string | null): Omit<AdapterHolding, "ticker" | "qty" | "usd_override"> {
  return { contract: null, category: "defi", chain: "aster", icon_url: null, protocol: "Aster", protocol_url: APP_URL, protocol_section: section, display_label: label };
}

/** A position's base asset: the symbol less its quote (the collateral when
 * given, else a known dollar quote). */
export function baseAsset(p: Pick<AsterPosition, "symbol" | "collateral">): string {
  const quotes = [p.collateral, "USDT", "USDC", "USD1", "USDF", "USD"].filter((q): q is string => !!q);
  for (const q of quotes) if (p.symbol.endsWith(q) && p.symbol.length > q.length) return p.symbol.slice(0, -q.length);
  return p.symbol;
}

/** Margin a position ties up: isolated → its isolated wallet; cross →
 * notional ÷ leverage. */
export function asterMargin(p: AsterPosition): number {
  if (p.isolated) return Math.abs(num(p.isolatedWallet) ?? 0);
  const lev = num(p.leverage);
  return lev && lev > 0 ? Math.abs(num(p.notionalValue) ?? 0) / lev : 0;
}

export function asterHoldings(b: AsterBalance): { holdings: AdapterHolding[]; warnings: string[] } {
  const holdings: AdapterHolding[] = [];
  const warnings: string[] = [];
  if (b.accountPrivacy && b.accountPrivacy !== "disabled") warnings.push("aster: the account has privacy mode on — balances may be hidden");

  const perps = (b.positions ?? []).flatMap((g) => (g.tradingProduct === "perps" ? g.positions : []));
  const open = perps.filter((p) => (num(p.positionAmount) ?? 0) !== 0);
  const pnlTotal = open.reduce((s, p) => s + (num(p.unrealizedProfit) ?? 0), 0);

  let stableWallet = 0;
  for (const a of b.perpAssets ?? []) {
    const qty = num(a.walletBalance) ?? 0;
    const asset = a.asset.toUpperCase();
    if (qty === 0) continue;
    if (STABLE.has(asset)) {
      stableWallet += qty;
      continue;
    }
    holdings.push({ ...base("Deposit", "Collateral"), ticker: asset, qty, usd_override: null, coingecko_id: ASTER_COINS[asset] ?? null });
  }

  const margins = open.map(asterMargin);
  // Stable collateral plus unrealized PnL, less the positions' margin — each
  // position row below carries its own.
  const available = perpsUnallocatedUsd(stableWallet + pnlTotal, 0, margins);
  if (available !== null) holdings.push({ ...base("Deposit", "Available"), ticker: "USDT", qty: available, usd_override: available });

  open.forEach((p, i) => {
    const amount = num(p.positionAmount) ?? 0;
    const side = p.positionSide === "SHORT" || (p.positionSide !== "LONG" && amount < 0) ? "short" : "long";
    const pnl = num(p.unrealizedProfit);
    const margin = margins[i];
    holdings.push({
      ...base("Perpetuals", null),
      ticker: `${baseAsset(p)}-PERP`,
      contract: p.symbol,
      qty: Math.abs(amount),
      usd_override: margin,
      position_side: side,
      position_leverage: num(p.leverage),
      position_entry_price: num(p.entryPrice),
      position_liquidation_price: null, // not in the by-address response
      position_pnl_usd: pnl,
      position_pnl_percent: pnl !== null && margin > 0 ? (pnl / margin) * 100 : null,
    });
  });

  const staked = num(b.staking?.totalStakedAmount) ?? 0;
  if (staked > 0) holdings.push({ ...base("Staked", "Staked ASTER"), ticker: "ASTER", qty: staked, usd_override: null, coingecko_id: ASTER_COINS.ASTER });
  for (const r of b.staking?.totalUnclaimedRewards ?? []) {
    const qty = num(r.amount) ?? 0;
    const asset = r.asset.toUpperCase();
    if (qty > 0) holdings.push({ ...base("Rewards", "Staking rewards"), ticker: asset, qty, usd_override: null, coingecko_id: ASTER_COINS[asset] ?? null });
  }
  return { holdings, warnings };
}
