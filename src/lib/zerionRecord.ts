// An EVM address's trading record from Zerion's profit and loss (owner
// 2026-09-30): which calls a load makes, and the stored record from their
// answers. Past months don't change, so only the current month, the
// windows and all-time are asked again; a month Zerion couldn't answer is
// asked again next time. Pure.

import type { StoredTradingRecord } from "./tradingRecord.ts";

export interface PnlAnswer {
  realizedUsd: number;
  unrealizedUsd: number;
  investedUsd: number;
  relativeTotalPct: number | null;
}

export type ZerionWindow = { kind: "all" } | { kind: "d30" | "d90"; sinceMs: number; tillMs: number } | { kind: "month"; month: string; sinceMs: number; tillMs: number; endMs: number };

const DAY_MS = 86_400_000;
const monthStart = (y: number, m: number) => Date.UTC(y, m, 1);

/** The windows to ask about: all-time, 30 and 90 days, and each of the past
 * 12 months not already stored (the current one always). */
export function zerionWindows(prev: StoredTradingRecord | null, nowMs: number): ZerionWindow[] {
  const out: ZerionWindow[] = [{ kind: "all" }, { kind: "d30", sinceMs: nowMs - 30 * DAY_MS, tillMs: nowMs }, { kind: "d90", sinceMs: nowMs - 90 * DAY_MS, tillMs: nowMs }];
  const now = new Date(nowMs);
  for (let i = 0; i < 12; i++) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() - i;
    const since = monthStart(y, m);
    const month = new Date(since).toISOString().slice(0, 7);
    const current = i === 0;
    if (!current && prev?.months?.[month]?.[2] === 1) continue; // a past month, stored after it ended
    out.push({ kind: "month", month, sinceMs: since, tillMs: current ? nowMs : monthStart(y, m + 1), endMs: monthStart(y, m + 1) });
  }
  return out;
}

/** The record from this load's answers (null = no answer) on top of the
 * stored one. Without an all-time answer there's no record. */
export function zerionRecord(prev: StoredTradingRecord | null, answers: readonly { window: ZerionWindow; pnl: PnlAnswer | null }[], askedAtMs: number): StoredTradingRecord | null {
  const all = answers.find((a) => a.window.kind === "all")?.pnl;
  if (!all) return null;
  const months: NonNullable<StoredTradingRecord["months"]> = { ...(prev?.months ?? {}) };
  const windows = { d30: null as number | null, d90: null as number | null };
  for (const { window: w, pnl } of answers) {
    // [realized, put in, 1 = the whole month (asked after it ended)]
    if (w.kind === "month") months[w.month] = pnl ? [pnl.realizedUsd, pnl.investedUsd, w.endMs <= askedAtMs ? 1 : 0] : (months[w.month] ?? null);
    if (w.kind === "d30" || w.kind === "d90") windows[w.kind] = pnl ? pnl.realizedUsd : null;
  }
  // The summary's return is (proceeds − put in) ÷ put in; proceeds is set so
  // that gives Zerion's own total gain %.
  const invested = all.investedUsd;
  const proceeds = all.relativeTotalPct !== null ? invested * (1 + all.relativeTotalPct / 100) : invested + all.realizedUsd + all.unrealizedUsd;
  const active = Object.entries(months).filter(([, v]) => v && (v[0] !== 0 || v[1] !== 0)).map(([m]) => m).sort();
  return {
    source: "zerion",
    realizedUsd: all.realizedUsd,
    unrealizedUsd: all.unrealizedUsd,
    investedUsd: invested,
    proceedsUsd: proceeds,
    closedTokens: 0,
    winningTokens: 0,
    losingTokens: 0,
    distribution: [],
    avgHoldSecs: null,
    firstTradeAt: active[0] ? `${active[0]}-01T00:00:00.000Z` : null,
    lastTradeAt: null,
    days: [],
    drawdownUsd: null,
    drawdownPct: null,
    months,
    windows,
  };
}
