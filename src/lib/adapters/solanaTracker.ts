import "server-only";
import { fetchWithRetry } from "./http";
import type { StoredTradingRecord } from "../tradingRecord";

// Solana Tracker's PnL v2 API (docs.solanatracker.io/guides/pnl-v2): a
// Solana wallet's trading record in USD. Free plan: 2,500 requests a month,
// 3 a second (API list: src/lib/apiRegistry.ts). Two requests per wallet —
// the all-time summary and the past 365 days day by day — checked live on
// 2026-09-28 (Hash: +$157.9K realized over the year, $120.8K of it in
// September). A failure throws: an error is never an empty record.

const BASE = "https://data.solanatracker.io/v2/pnl/wallets";
const API_KEY = process.env.SOLANA_TRACKER_API_KEY;

async function get<T>(path: string): Promise<T> {
  if (!API_KEY) throw new Error("Solana Tracker: no API key");
  const res = await fetchWithRetry(`${BASE}/${path}`, { headers: { "x-api-key": API_KEY }, cache: "no-store" });
  if (!res.ok) throw new Error(`Solana Tracker: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as T;
}

interface Summary {
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

/** A wallet's trading record: all-time totals and the past year's days. */
export async function fetchTradingRecord(address: string): Promise<StoredTradingRecord> {
  const summary = await get<Summary>(`${address}?currency=usd`);
  const perf = await get<Performance>(`${address}/performance?days=365&currency=usd`);
  const s = summary.summary ?? {};
  const t = summary.analysis?.tokens ?? {};
  return {
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
  };
}
