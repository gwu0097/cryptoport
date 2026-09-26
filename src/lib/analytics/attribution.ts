// What moved the portfolio over a window: how much of the change is price
// moves on what is held now, and how much is everything else. Pure.
//
// Holdings-based attribution: each asset's price effect is its value now
// minus what the same quantity was worth at the start of the window
// (value − value / (1 + change)), from the asset's own 24h/7d/30d change
// (asset_prices). The actual change is the live total minus the daily
// snapshot from that day (portfolio_snapshots). The difference is
// everything that isn't a price move on today's holdings: deposits and
// withdrawals, wallets added or removed, trades, positions opened or
// closed, rewards — and price moves on coins no longer held. It is shown as
// that, never split further without the data to do it.

export type AttributionWindow = "24h" | "7d" | "30d";

export const WINDOW_DAYS: Record<AttributionWindow, number> = { "24h": 1, "7d": 7, "30d": 30 };

export interface AttributionAssetInput {
  key: string;
  ticker: string;
  valueUsd: number;
  /** Percent changes (5 = +5%), null when the source has none. */
  change: Record<AttributionWindow, number | null>;
}

export interface AssetContribution {
  key: string;
  ticker: string;
  valueUsd: number;
  changePct: number;
  usd: number;
}

export interface Attribution {
  window: AttributionWindow;
  /** The snapshot the window starts from; null when there is none for
   * that day (then the actual change is unknown). */
  base: { date: string; totalUsd: number } | null;
  actualUsd: number | null;
  priceUsd: number;
  /** actual − price; null when the actual change is unknown. */
  otherUsd: number | null;
  contributions: AssetContribution[];
  /** Held value with no change figure for the window (e.g. a Jupiter-priced
   * token's 7d), and protocol positions valued as a whole. */
  unattributed: { usd: number; tickers: string[] };
}

export function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * `positionsUsd`: value held outside any priced asset (protocol positions,
 * perp margin), which moves but has no price change to attribute.
 * `snapshots`: daily totals, `today` the request's UTC date.
 */
export function attribute(
  window: AttributionWindow,
  assets: readonly AttributionAssetInput[],
  positions: { usd: number; tickers: string[] },
  liveTotalUsd: number,
  snapshots: readonly { date: string; total: number }[],
  today: string,
): Attribution {
  const contributions: AssetContribution[] = [];
  const unattributed = { usd: positions.usd, tickers: [...positions.tickers] };
  for (const a of assets) {
    if (a.valueUsd <= 0) continue;
    const pct = a.change[window];
    // A change of −100% or less can't be inverted to a starting value.
    if (pct === null || pct <= -100) {
      unattributed.usd += a.valueUsd;
      unattributed.tickers.push(a.ticker);
      continue;
    }
    contributions.push({ key: a.key, ticker: a.ticker, valueUsd: a.valueUsd, changePct: pct, usd: a.valueUsd - a.valueUsd / (1 + pct / 100) });
  }
  contributions.sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
  const priceUsd = contributions.reduce((s, c) => s + c.usd, 0);

  const baseDate = daysBefore(today, WINDOW_DAYS[window]);
  const snap = snapshots.find((s) => s.date === baseDate);
  const base = snap ? { date: snap.date, totalUsd: snap.total } : null;
  const actualUsd = base ? liveTotalUsd - base.totalUsd : null;
  return { window, base, actualUsd, priceUsd, otherUsd: actualUsd === null ? null : actualUsd - priceUsd, contributions, unattributed };
}
