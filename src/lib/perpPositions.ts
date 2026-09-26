// Open perp positions' current PnL between wallet syncs. A sync stores each
// position's size, entry, side and the venue's own PnL at that moment; a
// price refresh stores the venue's current MARK price under a position key
// (asset_prices, e.g. "hlperp:LIT"). Whichever is newer is shown: the synced
// PnL, or size × (mark − entry) — the venue's own unrealized-PnL formula
// (Hyperliquid: position size × (mark − entry), signed by side). Display
// only: a position is valued at its margin in every total, and on Hyperliquid
// the account's cash already moves with PnL, so adding PnL would count it
// twice. Pure.

export interface PositionInput {
  chain: string | null;
  ticker: string;
  qty: number | null;
  side: "long" | "short" | null;
  entryPrice: number | null;
  /** The position's value in totals (its margin). */
  marginUsd: number | null;
  syncedPnlUsd: number | null;
  syncedPnlPercent: number | null;
  /** When the wallet was last synced (ISO). */
  syncedAt: string | null;
}

export interface Mark {
  usd: number;
  at: string; // ISO, when it was fetched
}

export interface CurrentPnl {
  pnlUsd: number | null;
  /** Return on margin, as the venue shows it. */
  pnlPercent: number | null;
  markPrice: number | null;
  source: "mark" | "sync";
  asOf: string | null;
}

/** The asset_prices key holding a position's venue mark price, or null when
 * the venue isn't covered yet. Hyperliquid rows are "<COIN>-PERP". */
export function markKeyFor(p: { chain: string | null; ticker: string }): string | null {
  if (p.chain === "hyperliquid" && p.ticker.endsWith("-PERP")) return `hlperp:${p.ticker.slice(0, -"-PERP".length)}`;
  return null;
}

export function currentPnl(p: PositionInput, mark: Mark | undefined): CurrentPnl {
  const fromSync: CurrentPnl = { pnlUsd: p.syncedPnlUsd, pnlPercent: p.syncedPnlPercent, markPrice: null, source: "sync", asOf: p.syncedAt };
  if (!mark || !Number.isFinite(mark.usd) || mark.usd <= 0) return fromSync;
  if (p.syncedAt && Date.parse(mark.at) <= Date.parse(p.syncedAt)) return { ...fromSync, markPrice: mark.usd };
  if (p.qty === null || p.entryPrice === null || !p.side || !Number.isFinite(p.qty) || !Number.isFinite(p.entryPrice)) return { ...fromSync, markPrice: mark.usd };
  const pnlUsd = Math.abs(p.qty) * (mark.usd - p.entryPrice) * (p.side === "long" ? 1 : -1);
  const pnlPercent = p.marginUsd !== null && p.marginUsd > 0 ? (pnlUsd / p.marginUsd) * 100 : null;
  return { pnlUsd, pnlPercent, markPrice: mark.usd, source: "mark", asOf: mark.at };
}

/** Total PnL of the open positions (unknown ones left out and counted). */
export function totalPnl(list: readonly CurrentPnl[]): { usd: number; unknown: number } {
  let usd = 0;
  let unknown = 0;
  for (const c of list) {
    if (c.pnlUsd === null || !Number.isFinite(c.pnlUsd)) unknown++;
    else usd += c.pnlUsd;
  }
  return { usd, unknown };
}

/** A holding row with its PnL fields as they should be shown now: the live
 * figure when a mark newer than the wallet's sync exists, else unchanged.
 * Rows that aren't open positions pass through. */
export function withCurrentPnl<
  H extends {
    chain: string | null;
    ticker: string;
    qty: number | string | null;
    usd_override: number | string | null;
    position_side?: "long" | "short" | null;
    position_entry_price?: number | string | null;
    position_pnl_usd?: number | string | null;
    position_pnl_percent?: number | string | null;
  },
>(h: H, syncedAt: string | null, marks: ReadonlyMap<string, Mark>): H {
  if (!h.position_side) return h;
  const key = markKeyFor(h);
  const mark = key ? marks.get(key) : undefined;
  if (!mark) return h;
  const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
  const c = currentPnl(
    {
      chain: h.chain,
      ticker: h.ticker,
      qty: num(h.qty),
      side: h.position_side,
      entryPrice: num(h.position_entry_price),
      marginUsd: num(h.usd_override),
      syncedPnlUsd: num(h.position_pnl_usd),
      syncedPnlPercent: num(h.position_pnl_percent),
      syncedAt,
    },
    mark,
  );
  return c.source === "mark" ? { ...h, position_pnl_usd: c.pnlUsd, position_pnl_percent: c.pnlPercent } : h;
}
