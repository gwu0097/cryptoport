import "server-only";
import { fetchWithRetry } from "./http";
import { mergeCoins, type FetchedCoin, type StoredTradingRecord } from "../tradingRecord";

// Solana Tracker's PnL v2 API (docs.solanatracker.io/guides/pnl-v2): a
// Solana wallet's trading record in USD. Free plan: 2,500 requests a month,
// 3 a second (API list: src/lib/apiRegistry.ts). Two requests per wallet —
// the all-time summary and the past 365 days day by day — checked live on
// 2026-09-28 (Hash: +$157.9K realized over the year, $120.8K of it in
// September). A failure throws: an error is never an empty record.

const BASE = "https://data.solanatracker.io/v2/pnl/wallets";
const API_KEY = process.env.SOLANA_TRACKER_API_KEY;

/** A wallet Solana Tracker hasn't computed yet can answer 500 ("Failed to
 * fetch wallet overview") and then 200 moments later (Ethan Prosper,
 * 2026-09-28) — so a server error is retried twice, 3 s apart. */
const SERVER_ERROR_RETRIES = 2;
const SERVER_ERROR_WAIT_MS = 3000;

async function get<T>(path: string): Promise<T> {
  if (!API_KEY) throw new Error("Solana Tracker: no API key");
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(`${BASE}/${path}`, { headers: { "x-api-key": API_KEY }, cache: "no-store" });
    if (res.ok) return (await res.json()) as T;
    const text = (await res.text()).slice(0, 120);
    if (res.status >= 500 && attempt < SERVER_ERROR_RETRIES) {
      await new Promise((r) => setTimeout(r, SERVER_ERROR_WAIT_MS));
      continue;
    }
    throw new Error(`Solana Tracker: HTTP ${res.status} ${text}`);
  }
}

interface Summary {
  /** false (with queued) while Solana Tracker hasn't indexed the wallet yet:
   * an answer with no figures, not a record of $0. */
  indexed?: boolean;
  queued?: boolean;
  summary?: {
    pnl?: { realized?: number; unrealized?: number };
    invested?: number;
    proceeds?: number;
    timing?: { firstTrade?: number | null; lastTrade?: number | null; avgHoldTimeSecs?: number | null };
  };
  analysis?: { tokens?: { closed?: number; winning?: number; losing?: number }; distribution?: { range: string; count: number }[] };
}
interface Performance {
  days?: { date: string; realizedPnl: number; trades: number }[];
  drawdown?: { amount?: number; percent?: number };
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export const NOT_INDEXED = "Solana Tracker is still indexing this wallet (its first look) — try again in a few minutes";

interface PositionsPage {
  positions?: {
    token: string;
    pnl?: { realized?: number };
    invested?: number | null;
    roi?: number | null;
    timing?: { lastSell?: number | null; lastTrade?: number };
    meta?: { symbol?: string };
  }[];
  pagination?: { hasMore?: boolean; nextCursor?: string | null };
}

/** Pages of coins per load at most (100 each): a year of a trader as busy
 * as Hash (2,394 coins) is ~24. */
export const MAX_POSITION_PAGES = 25;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Coins newest-first (by last trade), down to `sinceMs` — the last load's
 * newest, so a refresh reads only what's new (usually one page) — or a
 * year back on the first load. */
async function fetchCoinsSince(address: string, sinceMs: number | null, nowMs: number): Promise<{ coins: FetchedCoin[]; pages: number; complete: boolean }> {
  const stop = sinceMs ?? nowMs - YEAR_MS;
  const coins: FetchedCoin[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_POSITION_PAGES; page++) {
    const body: PositionsPage = await get<PositionsPage>(`${address}/positions?currency=usd&sort=last_trade&direction=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    let reachedOld = false;
    for (const p of body.positions ?? []) {
      const lastTradeMs = p.timing?.lastTrade ?? 0;
      if (lastTradeMs <= stop) {
        reachedOld = true;
        break;
      }
      coins.push({ mint: p.token, symbol: p.meta?.symbol ?? p.token.slice(0, 4), realizedUsd: p.pnl?.realized ?? 0, roiPct: p.roi ?? null, investedUsd: p.invested ?? null, lastSellMs: p.timing?.lastSell ?? null, lastTradeMs });
    }
    cursor = body.pagination?.nextCursor ?? null;
    if (reachedOld || !body.pagination?.hasMore || !cursor) return { coins, pages: page, complete: true };
  }
  return { coins, pages: MAX_POSITION_PAGES, complete: false };
}

/** A wallet's trading record: all-time totals, the past year's days, and
 * its coins (only those traded since `prev` was loaded). */
export async function fetchTradingRecord(
  address: string,
  prev: StoredTradingRecord | null,
  nowMs: number,
): Promise<{ record: StoredTradingRecord; coinPages: number; firstCoinLoad: boolean; newCoins: number }> {
  const summary = await get<Summary>(`${address}?currency=usd`);
  // Not indexed yet (2026-10-01: a $293K wallet came back as "$0 everywhere"):
  // unknown, never 0 — say so and keep what was stored.
  if (summary.indexed === false || !summary.summary) throw new Error(NOT_INDEXED);
  const perf = await get<Performance>(`${address}/performance?days=365&currency=usd`);
  const firstCoinLoad = !prev?.coins?.cursor;
  const fetched = await fetchCoinsSince(address, prev?.coins?.cursor ?? null, nowMs);
  const s = summary.summary ?? {};
  const t = summary.analysis?.tokens ?? {};
  const record: StoredTradingRecord = {
    realizedUsd: s.pnl?.realized ?? 0,
    unrealizedUsd: s.pnl?.unrealized ?? 0,
    investedUsd: s.invested ?? 0,
    proceedsUsd: s.proceeds ?? 0,
    closedTokens: t.closed ?? 0,
    winningTokens: t.winning ?? 0,
    losingTokens: t.losing ?? 0,
    distribution: (summary.analysis?.distribution ?? []).map((d) => ({ range: d.range, count: d.count })),
    avgHoldSecs: s.timing?.avgHoldTimeSecs ?? null,
    firstTradeAt: iso(s.timing?.firstTrade),
    lastTradeAt: iso(s.timing?.lastTrade),
    days: (perf.days ?? []).map((d) => [d.date, d.realizedPnl, d.trades] as [string, number, number]),
    drawdownUsd: perf.drawdown?.amount ?? null,
    drawdownPct: perf.drawdown?.percent ?? null,
    coins: mergeCoins(prev?.coins, fetched.coins, nowMs),
  };
  return { record, coinPages: fetched.pages, firstCoinLoad, newCoins: fetched.coins.length };
}
