// The open positions' headline numbers — shown in the Dashboard's stat
// strip and the Open positions panel's header, from the same positions.
// Pure.

export interface PositionLike {
  kind: "perp" | "prediction";
  pnlUsd: number | null;
  valueUsd: number | null;
}

export interface PositionsSummary {
  count: number;
  /** Sum of the positions with a known PnL; null when none has one. */
  pnlUsd: number | null;
  /** Positions without a PnL (left out of pnlUsd, never counted as 0). */
  unknownPnl: number;
  perps: number;
  /** Margin locked in perps (their value in totals). */
  marginUsd: number;
  predictions: number;
  /** What prediction positions are worth now. */
  predictionUsd: number;
}

export function summarizePositions(positions: readonly PositionLike[]): PositionsSummary {
  const known = positions.filter((p) => p.pnlUsd !== null);
  const perps = positions.filter((p) => p.kind === "perp");
  const predictions = positions.filter((p) => p.kind === "prediction");
  return {
    count: positions.length,
    pnlUsd: known.length ? known.reduce((s, p) => s + (p.pnlUsd as number), 0) : null,
    unknownPnl: positions.length - known.length,
    perps: perps.length,
    marginUsd: perps.reduce((s, p) => s + (p.valueUsd ?? 0), 0),
    predictions: predictions.length,
    predictionUsd: predictions.reduce((s, p) => s + (p.valueUsd ?? 0), 0),
  };
}
