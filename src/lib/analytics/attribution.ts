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

export interface WalletAttributionInput {
  id: string;
  name: string;
  /** When the wallet was added (ISO); one added after the base snapshot
   * explains its whole value as "everything else". */
  createdAt: string | null;
  liveUsd: number;
  assets: readonly AttributionAssetInput[];
  /** Value held outside a priced coin (perp margin, protocol positions). */
  positions: { usd: number; tickers: string[] };
}

export interface WalletAttribution {
  id: string;
  name: string;
  /** The wallet's value in the base snapshot; null when it had none. */
  baseUsd: number | null;
  liveUsd: number;
  actualUsd: number | null;
  priceUsd: number;
  otherUsd: number | null;
  /** Added after the base snapshot: its whole value is new. */
  added: boolean;
  positionsUsd: number;
  /** Holdings with no change figure for the window (their moves land in "other"). */
  unattributedCount: number;
}

/**
 * "Everything else" split by wallet: each wallet's change since its own
 * daily snapshot (wallet_snapshots) minus its price effect. Wallets in the
 * base snapshot that are gone now (removed, deactivated) are one line of
 * their own, so the rows add up to the portfolio's "everything else" when
 * every wallet has a base row.
 */
export function attributeByWallet(
  window: AttributionWindow,
  wallets: readonly WalletAttributionInput[],
  baseByWallet: ReadonlyMap<string, number>,
  today: string,
): { wallets: WalletAttribution[]; removedUsd: number } {
  const baseDate = daysBefore(today, WINDOW_DAYS[window]);
  const rows = wallets.map((w): WalletAttribution => {
    const a = attribute(window, w.assets, w.positions, w.liveUsd, [], today);
    const base = baseByWallet.get(w.id);
    // Added after the base day's snapshot (or on it, before the snapshot ran
    // — so a missing base row with a recent creation date counts as new).
    const added = base === undefined && !!w.createdAt && w.createdAt.slice(0, 10) >= baseDate;
    const baseUsd = base ?? (added ? 0 : null);
    const actualUsd = baseUsd === null ? null : w.liveUsd - baseUsd;
    return {
      id: w.id,
      name: w.name,
      baseUsd,
      liveUsd: w.liveUsd,
      actualUsd,
      // A wallet that didn't exist had no holdings for prices to move.
      priceUsd: added ? 0 : a.priceUsd,
      otherUsd: actualUsd === null ? null : actualUsd - (added ? 0 : a.priceUsd),
      added,
      positionsUsd: w.positions.usd,
      unattributedCount: a.unattributed.tickers.length,
    };
  });
  const live = new Set(wallets.map((w) => w.id));
  const removedUsd = [...baseByWallet].filter(([id]) => !live.has(id)).reduce((s, [, usd]) => s - usd, 0);
  return { wallets: rows.sort((x, y) => Math.abs(y.otherUsd ?? 0) - Math.abs(x.otherUsd ?? 0)), removedUsd };
}
