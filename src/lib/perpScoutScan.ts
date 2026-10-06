import "server-only";
import { serviceDb } from "./supabase";
import { mapWithConcurrency } from "./adapters/http";
import { fetchAccountState, fetchLeaderboard, fetchOpenOrders, fetchPortfolio, fetchRecentFills } from "./adapters/hyperliquidScout";
import { passesStage1, pickForReview, stage3Failures, traderScore } from "./perpScout/screen";
import { traderStats, type TraderStats } from "./perpScout/portfolio";
import { accountLeverage, buildEntries, netBias, type ScoutEntry } from "./perpScout/entries";

// Perp Scout's scan (docs/perp-scout/PLAN.md): screen the Hyperliquid
// leaderboard down to the top TOP_N traders (reused for SCREEN_TTL_MS), then
// read each one's open positions, fills and TP/SL orders. The result is
// public market data, one shared row in app_settings (SETTING) that every
// viewer reads; one scan runs at a time (RUN_SETTING, compare-and-set).

const SETTING = "perp_scout";
const RUN_SETTING = "perp_scout_run";
export const TOP_N = 20;
const REVIEW_N = 50;
const SCREEN_TTL_MS = 24 * 60 * 60_000;
/** A scan this recent is reused instead of run again. */
const FRESH_MS = 2 * 60_000;
/** A claimed run older than this died (the route has 300 s). */
const RUN_STALE_MS = 6 * 60_000;
/** Stop reading accounts after this; the rest keep their last entries. */
const DEADLINE_MS = 250_000;
const CONCURRENCY = 4;

export interface ScoutTrader {
  address: string;
  displayName: string | null;
  accountValue: number;
  allTimePnl: number;
  allTimeRoi: number;
  monthPnl: number;
  weekPnl: number;
  stats: TraderStats;
  score: number;
}

export interface ScoutScreen {
  screenedAt: string;
  leaderboardCount: number;
  stage1Count: number;
  reviewedCount: number;
  /** Reviewed accounts whose history couldn't be read. */
  failedCount: number;
  passedCount: number;
  traders: ScoutTrader[];
}

export interface ScoutBook {
  address: string;
  /** When its positions were read; on a failed read, the last good one. */
  readAt: string | null;
  error: string | null;
  accountValue: number | null;
  leverage: number | null;
  bias: number | null;
  positions: number;
}

export interface ScoutScan {
  scannedAt: string;
  books: ScoutBook[];
  entries: ScoutEntry[];
}

export interface PerpScoutData {
  screen: ScoutScreen | null;
  scan: ScoutScan | null;
}

export type ScanProgress = { stage: "leaderboard" } | { stage: "screen" | "positions"; done: number; total: number } | { stage: "saving" };

export async function readPerpScout(): Promise<PerpScoutData> {
  const { data, error } = await serviceDb().from("app_settings").select("value").eq("key", SETTING).maybeSingle();
  if (error) throw new Error(error.message);
  const v = (data?.value ?? {}) as Partial<PerpScoutData>;
  return { screen: v.screen ?? null, scan: v.scan ?? null };
}

async function save(value: PerpScoutData): Promise<void> {
  const { error } = await serviceDb().from("app_settings").upsert({ key: SETTING, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Perp Scout not saved: ${error.message}`);
}

/** One scan at a time across instances: claims RUN_SETTING with a
 * compare-and-set on its updated_at. */
async function claimRun(): Promise<{ ok: true; release: () => Promise<void> } | { ok: false }> {
  const db = serviceDb();
  const now = new Date();
  const { data } = await db.from("app_settings").select("value, updated_at").eq("key", RUN_SETTING).maybeSingle();
  const v = (data?.value ?? null) as { running?: boolean } | null;
  if (data && v?.running && now.getTime() - Date.parse(data.updated_at) < RUN_STALE_MS) return { ok: false };
  const value = { running: true, startedAt: now.toISOString() };
  const claimed = data
    ? await db.from("app_settings").update({ value, updated_at: now.toISOString() }).eq("key", RUN_SETTING).eq("updated_at", data.updated_at).select("key")
    : await db.from("app_settings").insert({ key: RUN_SETTING, value, updated_at: now.toISOString() }).select("key");
  if (claimed.error || !claimed.data?.length) return { ok: false };
  return {
    ok: true,
    release: async () => {
      await db.from("app_settings").update({ value: { running: false, startedAt: now.toISOString(), finishedAt: new Date().toISOString() }, updated_at: new Date().toISOString() }).eq("key", RUN_SETTING);
    },
  };
}

async function screenTraders(progress: (p: ScanProgress) => void): Promise<ScoutScreen> {
  progress({ stage: "leaderboard" });
  const board = await fetchLeaderboard();
  const stage1 = board.filter(passesStage1);
  const review = pickForReview(stage1, REVIEW_N);
  const now = Date.now();
  let done = 0;
  let failedCount = 0;
  const reviewed = await mapWithConcurrency(review, CONCURRENCY, async (row) => {
    try {
      const stats = traderStats(await fetchPortfolio(row.address), now);
      return { row, stats };
    } catch (e) {
      failedCount++;
      console.error(`[perp-scout] ${row.address} history: ${(e as Error).message}`);
      return null;
    } finally {
      progress({ stage: "screen", done: ++done, total: review.length });
    }
  });
  const passed = reviewed
    .filter((r): r is NonNullable<typeof r> => r !== null && stage3Failures(r.stats).length === 0)
    .map(({ row, stats }) => ({ row, stats, score: traderScore(stats) }))
    .filter((r): r is typeof r & { score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score);
  if (failedCount === review.length && review.length > 0) throw new Error("No trader's history could be read from Hyperliquid");
  return {
    screenedAt: new Date(now).toISOString(),
    leaderboardCount: board.length,
    stage1Count: stage1.length,
    reviewedCount: review.length,
    failedCount,
    passedCount: passed.length,
    traders: passed.slice(0, TOP_N).map(({ row, stats, score }) => ({
      address: row.address,
      displayName: row.displayName,
      accountValue: row.accountValue,
      allTimePnl: row.allTime.pnl,
      allTimeRoi: row.allTime.roi,
      monthPnl: row.month.pnl,
      weekPnl: row.week.pnl,
      stats,
      score,
    })),
  };
}

/** One account's book. Orders and fills are read only with a position. */
async function readBook(address: string): Promise<{ book: ScoutBook; entries: ScoutEntry[] }> {
  const state = await fetchAccountState(address);
  const open = state.assetPositions.some(({ position }) => Number(position.szi) !== 0);
  const [fills, orders] = open
    ? await Promise.all([fetchRecentFills(address), fetchOpenOrders(address).catch(() => null)])
    : [[], null];
  const entries = buildEntries(address, state, fills, orders);
  const accountValue = Number(state.marginSummary?.accountValue);
  return {
    book: { address, readAt: new Date().toISOString(), error: null, accountValue: Number.isFinite(accountValue) ? accountValue : null, leverage: accountLeverage(state), bias: netBias(entries), positions: entries.length },
    entries,
  };
}

/**
 * A scan. `rescreen` re-runs the trader screen even when the last one is
 * under a day old. A trader whose positions can't be read (or aren't reached
 * before the deadline) keeps the previous scan's entries, marked with the
 * error — a failed read is never an empty book.
 */
export async function runScan(rescreen: boolean, progress: (p: ScanProgress) => void): Promise<{ status: "done" | "fresh" | "busy"; failed: number }> {
  const started = Date.now();
  const before = await readPerpScout();
  if (!rescreen && before.scan && started - Date.parse(before.scan.scannedAt) < FRESH_MS && before.screen) return { status: "fresh", failed: 0 };
  const claim = await claimRun();
  if (!claim.ok) return { status: "busy", failed: 0 };
  try {
    let screen = before.screen;
    if (rescreen || !screen || started - Date.parse(screen.screenedAt) > SCREEN_TTL_MS) {
      screen = await screenTraders(progress);
      await save({ screen, scan: before.scan });
    }
    const prevEntries = new Map<string, ScoutEntry[]>();
    for (const e of before.scan?.entries ?? []) prevEntries.set(e.address, [...(prevEntries.get(e.address) ?? []), e]);
    const prevBooks = new Map((before.scan?.books ?? []).map((b) => [b.address, b]));

    let done = 0;
    const traders = screen.traders;
    const results = await mapWithConcurrency(traders, CONCURRENCY, async (t) => {
      try {
        if (Date.now() - started > DEADLINE_MS) throw new Error("not reached in this scan (time limit)");
        return await readBook(t.address);
      } catch (e) {
        const prev = prevBooks.get(t.address);
        const error = (e as Error).message;
        console.error(`[perp-scout] ${t.address} positions: ${error}`);
        return {
          book: { address: t.address, readAt: prev?.readAt ?? null, error, accountValue: prev?.accountValue ?? null, leverage: prev?.leverage ?? null, bias: prev?.bias ?? null, positions: prev?.positions ?? 0 },
          entries: prevEntries.get(t.address) ?? [],
        };
      } finally {
        progress({ stage: "positions", done: ++done, total: traders.length });
      }
    });
    progress({ stage: "saving" });
    await save({ screen, scan: { scannedAt: new Date().toISOString(), books: results.map((r) => r.book), entries: results.flatMap((r) => r.entries) } });
    const failed = results.filter((r) => r.book.error).length;
    console.log(`[perp-scout] scan ${Math.round((Date.now() - started) / 1000)}s traders=${traders.length} failed=${failed} entries=${results.reduce((s, r) => s + r.entries.length, 0)}`);
    return { status: "done", failed };
  } finally {
    await claim.release().catch(() => {});
  }
}
