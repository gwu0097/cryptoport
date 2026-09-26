// Open perp positions' current PnL between wallet syncs. A sync stores each
// position's size, entry, side and the venue's own PnL at that moment; a
// price refresh stores the venue's current MARK price under a position key
// (asset_prices, e.g. "hlperp:LIT"). Whichever is newer is shown: the synced
// PnL, or size × (mark − entry) — the venue's own unrealized-PnL formula
// (Hyperliquid and Lighter: position size × (mark − entry), signed by side). Display
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

// Venue → the asset_prices namespace its perp marks are stored under. Both
// venues' position rows are "<SYMBOL>-PERP" (adapters/hyperliquid.ts,
// lighter.ts). A new venue is one entry here plus its lane in
// adapters/assetPrices.ts.
const MARK_PREFIX: Record<string, string> = { hyperliquid: "hlperp:", lighter: "lighterperp:", aster: "asterperp:" };

/** Every perp-mark key prefix (the holdings reads load these rows). */
export const MARK_KEY_PREFIXES: readonly string[] = Object.values(MARK_PREFIX);

/** The asset_prices key holding a position's venue mark price, or null when
 * the venue isn't covered yet. Aster markets are keyed by their symbol
 * ("BTCUSDT", the row's `contract`): one base trades against several quotes. */
export function markKeyFor(p: { chain: string | null; ticker: string; contract?: string | null }): string | null {
  const prefix = p.chain ? MARK_PREFIX[p.chain] : undefined;
  if (!prefix || !p.ticker.endsWith("-PERP")) return null;
  if (p.chain === "aster") return p.contract ? `${prefix}${p.contract}` : null;
  return `${prefix}${p.ticker.slice(0, -"-PERP".length)}`;
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

// ---- Open positions (the Dashboard section and its "Refresh positions") ----

/** Venues whose accounts "Refresh positions" re-reads: each is one account
 * call per wallet, and that venue's rows for the wallet are replaced as a
 * whole — positions, cash and margin together, so totals stay right (on
 * Hyperliquid, Lighter and Aster a position's PnL lands in the account's cash
 * rows, not the position's). A venue's rows are its `chain`, narrowed to one
 * `protocol` where the chain is shared (Solana DeFi). `wallet`: which wallets
 * have it (an EVM address, or a Solana one). */
export const POSITION_VENUES = [
  { id: "hyperliquid", chain: "hyperliquid", protocol: null, wallet: "evm" },
  { id: "lighter", chain: "lighter", protocol: null, wallet: "evm" },
  { id: "aster", chain: "aster", protocol: null, wallet: "evm" },
  { id: "polymarket", chain: "polymarket", protocol: null, wallet: "evm" },
  { id: "jupiter-perps", chain: "solana-defi", protocol: "Jupiter Perps", wallet: "solana" },
  { id: "jupiter-prediction", chain: "solana-defi", protocol: "Jupiter Prediction", wallet: "solana" },
] as const;
export type PositionVenue = (typeof POSITION_VENUES)[number];

/** Whether a row belongs to a venue (its chain, and protocol when set). */
export function venueOwns(v: PositionVenue, row: { chain: string | null; protocol?: string | null }): boolean {
  return row.chain === v.chain && (v.protocol === null || row.protocol === v.protocol);
}

/** An open position: a leveraged perp (any venue), or a prediction-market
 * position still worth something (a market lost or at 0 isn't open). */
export function isOpenPosition(h: {
  chain: string | null;
  position_side?: string | null;
  protocol_section?: string | null;
  usd_override?: number | string | null;
}): boolean {
  if (h.position_side) return true;
  return h.protocol_section === "Prediction" && Number(h.usd_override ?? 0) > 0;
}

/** Which of a wallet's venues have an open position, from its stored rows. */
export function venuesWithOpenPositions(rows: readonly (Parameters<typeof isOpenPosition>[0] & { protocol?: string | null })[]): PositionVenue[] {
  return POSITION_VENUES.filter((v) => rows.some((r) => venueOwns(v, r) && isOpenPosition(r)));
}

/** How long a venue account stays in "Refresh positions" after its last open
 * position: closing the last position and opening a new one days later is
 * still found without a full wallet sync. Past this, the venue is read again
 * only by a full sync (which re-marks it when it shows a position). */
export const RECENT_POSITION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The venues "Refresh positions" reads for one wallet: those with an open
 * position in its stored rows, plus those that had one within the window
 * (`lastPositionAt`: venue id → ISO time, from wallet_venue_activity). */
export function venuesToRefresh(
  rows: readonly (Parameters<typeof isOpenPosition>[0] & { protocol?: string | null })[],
  lastPositionAt: ReadonlyMap<string, string>,
  nowMs: number,
  windowMs: number = RECENT_POSITION_WINDOW_MS,
): PositionVenue[] {
  const open = new Set(venuesWithOpenPositions(rows).map((v) => v.id));
  return POSITION_VENUES.filter((v) => {
    if (open.has(v.id)) return true;
    const at = lastPositionAt.get(v.id);
    return at !== undefined && nowMs - Date.parse(at) <= windowMs;
  });
}
