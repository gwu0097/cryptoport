// A wallet's Jupiter prediction-market positions, from Jupiter's Prediction
// API (GET api.jup.ag/prediction/v1/positions; developers.jup.ag/docs/
// prediction/position-data). USD fields are strings in millionths of a
// dollar. Pure.
//
// What each position is worth:
//  - market open: `valueUsd` (Jupiter's mark-to-market value);
//  - market closed and the position won (`claimable`, not yet `claimed`):
//    its payout, $1 per contract (`payoutUsd`) — money waiting to be claimed;
//  - already claimed, or lost (the market has a `result` and the position
//    isn't claimable): nothing left, no row;
//  - closed but not yet resolved: unknown — a row with no value, shown as
//    "—", never 0 (CLAUDE.md §4.1).

export interface JupiterPredictionApiPosition {
  pubkey: string;
  isYes: boolean;
  contractsDecimal?: string;
  valueUsd: string | null;
  payoutUsd?: string;
  pnlUsd?: string | null;
  pnlUsdPercent?: number | null;
  claimable?: boolean;
  claimed?: boolean;
  eventMetadata?: { title?: string };
  marketMetadata?: { title?: string; result?: string | null };
}

export interface JupiterPredictionRow {
  pubkey: string;
  label: string;
  contracts: number | null;
  /** null = unknown (closed, not yet resolved). */
  valueUsd: number | null;
  pnlUsd: number | null;
  pnlPercent: number | null;
}

const MICRO = 1e6;
const micro = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n / MICRO : null;
};

function label(p: JupiterPredictionApiPosition): string {
  const event = p.eventMetadata?.title?.trim();
  const market = p.marketMetadata?.title?.trim();
  const side = p.isYes ? "YES" : "NO";
  const what = [event, market && market !== event ? market : null].filter(Boolean).join(" — ");
  return `${what || "Prediction"} (${side})`;
}

export function predictionRows(positions: readonly JupiterPredictionApiPosition[]): JupiterPredictionRow[] {
  const rows: JupiterPredictionRow[] = [];
  for (const p of positions) {
    if (p.claimed) continue;
    let value = micro(p.valueUsd);
    if (value === null) {
      if (p.claimable) value = micro(p.payoutUsd);
      else if (p.marketMetadata?.result) continue; // resolved against this position: lost
    }
    const contracts = p.contractsDecimal !== undefined && Number.isFinite(Number(p.contractsDecimal)) ? Number(p.contractsDecimal) : null;
    rows.push({
      pubkey: p.pubkey,
      label: label(p),
      contracts,
      valueUsd: value,
      pnlUsd: micro(p.pnlUsd),
      pnlPercent: typeof p.pnlUsdPercent === "number" && Number.isFinite(p.pnlUsdPercent) ? p.pnlUsdPercent : null,
    });
  }
  return rows;
}
