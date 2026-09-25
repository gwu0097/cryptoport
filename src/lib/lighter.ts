// Lighter (lighter.xyz perps DEX) account → holdings. Pure; the network part is
// adapters/lighter.ts. Same shape as Hyperliquid's (adapters/hyperliquid.ts):
//  - Deposit: USDC free to withdraw (`available_balance`), plus whatever of the
//    account's value isn't already free or a position's margin
//    (perpsUnallocatedUsd — the rows add up to `total_asset_value` once);
//  - Perpetuals: each open position valued at its margin (isolated:
//    `allocated_margin`; cross: `position_value × initial_margin_fraction`),
//    with side, leverage, entry, liquidation and unrealized PnL as detail;
//  - Spot: coins held on the spot side (`assets[].balance`);
//  - Yield: pool shares (LLP, LIT staking, public pools) at the pool's share
//    price. `total_asset_value` excludes them.
// Only the user's own accounts count (account_type 0 main, 1 sub-account); a
// public pool the address operates (type 2) holds other people's money.
// Decimals arrive as strings; a liquidation price of "0" means none.

import type { AdapterHolding } from "./adapters/types.ts";
import { perpsUnallocatedUsd } from "./hyperliquidPerps.ts";
import { stablecoinFallbackUsd } from "./stablecoinFallback.ts";

export interface LighterPosition {
  symbol: string;
  sign: number;
  position: string;
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  liquidation_price: string;
  initial_margin_fraction: string;
  margin_mode: number;
  allocated_margin: string;
}

export interface LighterAccount {
  account_type: number;
  index: number;
  available_balance: string;
  total_asset_value: string;
  positions?: LighterPosition[];
  assets?: { symbol: string; balance: string }[];
  shares?: { public_pool_index: number; shares_amount: number }[];
}

export interface LighterPoolPrice {
  name: string;
  usdPerShare: number;
}

const OWN_ACCOUNT_TYPES = new Set([0, 1]);
const APP_URL = "https://app.lighter.xyz";
const num = (s: string | number | null | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function base(label: string | null): Omit<AdapterHolding, "ticker" | "qty" | "usd_override" | "protocol_section"> {
  return { contract: null, category: "defi", chain: "lighter", icon_url: null, protocol: "Lighter", protocol_url: APP_URL, display_label: label };
}

/** Margin a position ties up: isolated → its allocated margin; cross → its
 * notional × initial margin fraction (a percentage, e.g. "5.00" = 20x). */
export function positionMargin(p: LighterPosition): number {
  if (p.margin_mode === 1) return num(p.allocated_margin) ?? 0;
  return (num(p.position_value) ?? 0) * ((num(p.initial_margin_fraction) ?? 0) / 100);
}

export function lighterHoldings(
  accounts: readonly LighterAccount[],
  poolPrices: ReadonlyMap<number, LighterPoolPrice>,
  spotUsd: ReadonlyMap<string, number>,
): AdapterHolding[] {
  const out: AdapterHolding[] = [];
  const own = accounts.filter((a) => OWN_ACCOUNT_TYPES.has(a.account_type));
  for (const a of own) {
    const suffix = own.length > 1 ? ` · account ${a.index}` : "";
    const available = num(a.available_balance) ?? 0;
    if (available > 0) {
      out.push({ ...base(`Available${suffix}`), ticker: "USDC", qty: available, usd_override: stablecoinFallbackUsd("USDC", available), protocol_section: "Deposit" });
    }

    const open = (a.positions ?? []).filter((p) => (num(p.position) ?? 0) !== 0);
    for (const p of open) {
      const margin = positionMargin(p);
      const imf = num(p.initial_margin_fraction);
      const pnl = num(p.unrealized_pnl);
      const liq = num(p.liquidation_price);
      out.push({
        ...base(suffix ? `Perpetual${suffix}` : null),
        ticker: `${p.symbol}-PERP`,
        qty: Math.abs(num(p.position) ?? 0),
        usd_override: margin,
        protocol_section: "Perpetuals",
        position_side: p.sign < 0 ? "short" : "long",
        position_leverage: imf && imf > 0 ? 100 / imf : null,
        position_entry_price: num(p.avg_entry_price),
        position_liquidation_price: liq && liq > 0 ? liq : null,
        position_pnl_usd: pnl,
        position_pnl_percent: pnl !== null && margin > 0 ? (pnl / margin) * 100 : null,
      });
    }

    const rest = perpsUnallocatedUsd(num(a.total_asset_value) ?? NaN, available, open.map(positionMargin));
    if (rest !== null) {
      out.push({ ...base(`Margin & PnL${suffix}`), ticker: "USDC", qty: rest, usd_override: stablecoinFallbackUsd("USDC", rest), protocol_section: "Deposit" });
    }

    for (const s of a.assets ?? []) {
      const qty = num(s.balance) ?? 0;
      if (qty <= 0) continue;
      const price = spotUsd.get(s.symbol.toUpperCase());
      out.push({
        ...base(`Spot${suffix}`),
        ticker: s.symbol.toUpperCase(),
        qty,
        // Priced by its coin when it maps to one (assetIdentity.ts); else
        // Lighter's own index price.
        usd_override: stablecoinFallbackUsd(s.symbol, qty) ?? (price === undefined ? null : qty * price),
        protocol_section: "Deposit",
      });
    }

    for (const sh of a.shares ?? []) {
      const pool = poolPrices.get(sh.public_pool_index);
      if (!sh.shares_amount) continue;
      out.push({
        ...base(pool?.name ?? `Pool ${sh.public_pool_index}`),
        ticker: "LIGHTER-POOL",
        qty: null,
        usd_override: pool ? sh.shares_amount * pool.usdPerShare : null,
        protocol_section: "Yield",
      });
    }
  }
  return out;
}

/** USD per share: (perps value + spot value) / total shares. */
export function poolSharePrice(p: { total_asset_value: string; total_spot_value: string; total_shares: number }): number | null {
  const value = (num(p.total_asset_value) ?? 0) + (num(p.total_spot_value) ?? 0);
  return p.total_shares > 0 ? value / p.total_shares : null;
}
