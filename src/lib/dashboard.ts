// Pure dashboard math/logic — no DB, no network. Kept separate from
// queries.ts (which is exclusively "how do I fetch this from Postgres")
// and from the dashboard components themselves, so it can be unit tested
// directly with node --test, same reasoning as valuation.ts.

export interface MoverInput {
  total: number;
  change24h: number | null;
}

export interface BlendedChange {
  usd: number;
  pct: number;
  /** What fraction of total tracked value this blend actually covers —
   * groups with no 24h data are excluded from the average entirely rather
   * than treated as 0% change, so this tells the caller how much of the
   * portfolio that average actually speaks for. */
  coveragePct: number;
}

/**
 * Dollar-weighted average 24h % change across every group that has one —
 * the standard "portfolio daily return" calculation. A group with no
 * change24h (unpriced, or no 24h data available anywhere) is excluded from
 * both the numerator and the weighting denominator, not treated as flat —
 * same "never silently coerce missing data into a number" rule as
 * valuation.ts's aggregate().
 */
export function blendedChange(groups: MoverInput[]): BlendedChange | null {
  let totalValue = 0;
  let coveredValue = 0;
  let weightedUsd = 0;

  for (const g of groups) {
    totalValue += g.total;
    if (g.change24h === null) continue;
    coveredValue += g.total;
    weightedUsd += g.total * (g.change24h / 100);
  }

  if (coveredValue === 0) return null;
  return {
    usd: weightedUsd,
    pct: (weightedUsd / coveredValue) * 100,
    coveragePct: totalValue === 0 ? 0 : (coveredValue / totalValue) * 100,
  };
}

/** Below this, an auto wallet's last sync is old enough to call out —
 * arbitrary but reasonable for a dashboard whose whole point is trusting
 * what it shows. */
export const STALE_HOURS = 24;

export interface WalletHealthInput {
  mode: string;
  last_refresh_at: string | null;
  last_refresh_status: string | null;
}

export type WalletHealthIssue =
  | { kind: "never_synced" }
  | { kind: "stale" }
  | { kind: "failed"; status: string };

/**
 * Manual wallets are never auto-synced by design — never flagged. An auto
 * wallet is flagged for exactly one of: never synced, stale (last sync
 * older than STALE_HOURS), or its last sync's own status wasn't "ok" (see
 * syncWalletHoldings in wallets/actions.ts for the exact status strings:
 * "ok" | "syncing" | "partial — ..." | "error: ..."). "syncing" is
 * deliberately not treated as a failure — it's a normal in-progress state;
 * a sync stuck mid-flight for a long time gets caught by the staleness
 * check instead, since last_refresh_at only advances on real completion.
 */
export function walletHealthIssue(wallet: WalletHealthInput, now: number = Date.now()): WalletHealthIssue | null {
  if (wallet.mode !== "auto") return null;
  if (!wallet.last_refresh_at) return { kind: "never_synced" };

  const hoursSince = (now - new Date(wallet.last_refresh_at).getTime()) / (1000 * 60 * 60);
  if (hoursSince >= STALE_HOURS) return { kind: "stale" };

  if (wallet.last_refresh_status && wallet.last_refresh_status !== "ok" && wallet.last_refresh_status !== "syncing") {
    return { kind: "failed", status: wallet.last_refresh_status };
  }
  return null;
}
