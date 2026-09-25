// INIT Capital (lending on Mantle) positions → holdings. Pure; the on-chain
// reads are adapters/initCapital.ts. A user's positions are ERC-721s owned by
// INIT's hook contracts, not the wallet, so they're found through the
// PosManager's viewer index. Each position's collateral is pool shares
// (converted with pool.toAmt) and its debt is debt shares (converted with
// pool.debtShareToAmtStored), both in the pool's underlying coin. Deposits
// and borrows are coin quantities priced by their coin (price_key from the
// contract); a borrow is negative — a debt, subtracted. Empty positions (most
// users have several) and zero amounts are skipped.

import type { AdapterHolding } from "./adapters/types.ts";

export interface InitPositionAmounts {
  posId: string;
  /** Underlying coin amounts already converted from shares. */
  collateral: { underlying: string; amount: bigint }[];
  borrows: { underlying: string; amount: bigint }[];
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

const APP_URL = "https://app.init.capital";

export function initHoldings(chain: string, positions: readonly InitPositionAmounts[], tokens: ReadonlyMap<string, TokenInfo>): AdapterHolding[] {
  const out: AdapterHolding[] = [];
  const live = positions.filter((p) => p.collateral.some((c) => c.amount > BigInt(0)) || p.borrows.some((b) => b.amount > BigInt(0)));
  for (const p of live) {
    const label = live.length > 1 ? `Position …${p.posId.slice(-6)}` : null;
    const row = (underlying: string, amount: bigint, sign: 1 | -1, section: string): AdapterHolding | null => {
      const t = tokens.get(underlying.toLowerCase());
      if (!t || amount <= BigInt(0)) return null;
      const qty = Number(amount) / 10 ** t.decimals;
      return {
        ticker: t.symbol,
        qty: sign * qty,
        usd_override: null, // priced by its coin (price_key from the contract)
        contract: underlying.toLowerCase(),
        category: "defi",
        chain,
        icon_url: null,
        protocol: "INIT Capital",
        protocol_url: APP_URL,
        protocol_section: section,
        display_label: label,
      };
    };
    for (const c of p.collateral) {
      const r = row(c.underlying, c.amount, 1, "Deposit");
      if (r) out.push(r);
    }
    for (const b of p.borrows) {
      const r = row(b.underlying, b.amount, -1, "Borrowed");
      if (r) out.push(r);
    }
  }
  return out;
}
