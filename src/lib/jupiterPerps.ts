// A wallet's open Jupiter Perps positions, from Jupiter's perps API
// (perps-api.jup.ag/v2/positions — what Jupiter's own CLI, jup-ag/cli
// PerpsClient.getPositions, reads). Every USD field there is a string in
// millionths of a dollar. Pure.
//
// Each position is isolated: its collateral is locked to it, and its PnL is
// not reflected in any other balance. So the position is worth what closing
// it now would return — Jupiter's `valueUsd` (= collateral + PnL after open,
// close and borrow fees; checked against a live position 2026-09-25) — not
// its margin alone, which is right for Hyperliquid only because Hyperliquid's
// cross-margin cash balance already includes unrealized PnL (hyperliquid.ts).

export interface JupiterPerpsApiPosition {
  asset: string;
  assetMint: string;
  side: string;
  leverage: string;
  sizeUsd: string;
  sizeTokenAmount: string;
  valueUsd: string;
  entryPriceUsd: string;
  liquidationPriceUsd: string;
  pnlAfterFeesUsd: string;
  pnlAfterFeesPct: string;
}

export interface JupiterPerpsRow {
  ticker: string;
  /** Position size in the market's coin, when it can be read. */
  qty: number | null;
  valueUsd: number;
  side: "long" | "short";
  leverage: number | null;
  entryPrice: number | null;
  liquidationPrice: number | null;
  pnlUsd: number | null;
  pnlPercent: number | null;
}

const MICRO = 1e6;

const micro = (s: string | undefined): number | null => {
  const n = Number(s);
  return s !== undefined && s !== "" && Number.isFinite(n) ? n / MICRO : null;
};
const plain = (s: string | undefined): number | null => {
  const n = Number(s);
  return s !== undefined && s !== "" && Number.isFinite(n) ? n : null;
};

/** Size in the market's coin = sizeUsd / entry price. (sizeTokenAmount is in
 * the coin's base units, whose decimals the response doesn't give; the ratio
 * stays right for any market Jupiter adds.) */
function sizeInCoin(p: JupiterPerpsApiPosition): number | null {
  const size = micro(p.sizeUsd);
  const entry = micro(p.entryPriceUsd);
  return size !== null && entry !== null && entry > 0 ? size / entry : null;
}

/**
 * One row per open position. A position whose value or side can't be read is
 * not guessed at: it's left out and counted in `unreadable`, so the sync can
 * warn and keep the previous rows.
 */
export function perpsRows(positions: readonly JupiterPerpsApiPosition[]): { rows: JupiterPerpsRow[]; unreadable: number } {
  const rows: JupiterPerpsRow[] = [];
  let unreadable = 0;
  for (const p of positions) {
    const value = micro(p.valueUsd);
    const side = p.side === "long" || p.side === "short" ? p.side : null;
    if (value === null || side === null || !p.asset) {
      unreadable++;
      continue;
    }
    rows.push({
      ticker: `${p.asset}-PERP`,
      qty: sizeInCoin(p),
      valueUsd: value,
      side,
      leverage: plain(p.leverage),
      entryPrice: micro(p.entryPriceUsd),
      liquidationPrice: micro(p.liquidationPriceUsd),
      pnlUsd: micro(p.pnlAfterFeesUsd),
      pnlPercent: plain(p.pnlAfterFeesPct),
    });
  }
  return { rows, unreadable };
}
