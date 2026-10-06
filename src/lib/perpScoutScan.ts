import "server-only";
import { serviceDb } from "./supabase";
import { mapWithConcurrency } from "./adapters/http";
import { fetchAccountState, fetchOpenOrders, fetchRecentFills } from "./adapters/hyperliquidScout";
import { accountLeverage, buildEntries, netBias, type ScoutEntry } from "./perpScout/entries";
import { FOLLOWED } from "./perpScout/followed";

// Perp Scout's scan (docs/perp-scout/PLAN.md): the open positions, latest
// fills and TP/SL orders of the traders in followed.ts — a list curated in
// chat, not found by the app (owner 2026-10-06). Public market data, one
// shared app_settings row (SETTING) every viewer reads; one scan at a time
// (RUN_SETTING, compare-and-set).

const SETTING = "perp_scout";
const RUN_SETTING = "perp_scout_run";
/** A scan this recent is reused instead of run again. */
const FRESH_MS = 60_000;
/** A claimed run older than this died (the route has 300 s). */
const RUN_STALE_MS = 6 * 60_000;
/** Stop reading accounts after this; the rest keep their last entries. */
const DEADLINE_MS = 250_000;
const CONCURRENCY = 4;

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

export type ScanProgress = { stage: "positions"; done: number; total: number } | { stage: "saving" };

/** The last scan, limited to the traders still on the list. */
export async function readPerpScout(): Promise<ScoutScan | null> {
  const { data, error } = await serviceDb().from("app_settings").select("value").eq("key", SETTING).maybeSingle();
  if (error) throw new Error(error.message);
  const scan = ((data?.value ?? null) as { scan?: ScoutScan } | null)?.scan ?? null;
  if (!scan) return null;
  const listed = new Set(FOLLOWED.map((f) => f.address));
  return { ...scan, books: scan.books.filter((b) => listed.has(b.address)), entries: scan.entries.filter((e) => listed.has(e.address)) };
}

async function readRaw(): Promise<ScoutScan | null> {
  const { data, error } = await serviceDb().from("app_settings").select("value").eq("key", SETTING).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data?.value ?? null) as { scan?: ScoutScan } | null)?.scan ?? null;
}

/** One scan at a time across instances: a compare-and-set on RUN_SETTING's
 * updated_at. */
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

/** One account's book. Orders and fills are read only with a position. */
async function readBook(address: string): Promise<{ book: ScoutBook; entries: ScoutEntry[] }> {
  const state = await fetchAccountState(address);
  const open = state.assetPositions.some(({ position }) => Number(position.szi) !== 0);
  const [fills, orders] = open ? await Promise.all([fetchRecentFills(address), fetchOpenOrders(address).catch(() => null)]) : [[], null];
  const entries = buildEntries(address, state, fills, orders);
  const accountValue = Number(state.marginSummary?.accountValue);
  return {
    book: { address, readAt: new Date().toISOString(), error: null, accountValue: Number.isFinite(accountValue) ? accountValue : null, leverage: accountLeverage(state), bias: netBias(entries), positions: entries.length },
    entries,
  };
}

/**
 * A scan of every listed trader. One whose positions can't be read (or
 * aren't reached before the deadline) keeps the previous scan's entries,
 * marked with the error — a failed read is never an empty book.
 */
export async function runScan(progress: (p: ScanProgress) => void): Promise<{ status: "done" | "fresh" | "busy" | "none"; failed: number }> {
  const started = Date.now();
  if (FOLLOWED.length === 0) return { status: "none", failed: 0 };
  const before = await readRaw();
  const sameList = before && before.books.length === FOLLOWED.length && FOLLOWED.every((f) => before.books.some((b) => b.address === f.address));
  if (sameList && started - Date.parse(before.scannedAt) < FRESH_MS) return { status: "fresh", failed: 0 };
  const claim = await claimRun();
  if (!claim.ok) return { status: "busy", failed: 0 };
  try {
    const prevEntries = new Map<string, ScoutEntry[]>();
    for (const e of before?.entries ?? []) prevEntries.set(e.address, [...(prevEntries.get(e.address) ?? []), e]);
    const prevBooks = new Map((before?.books ?? []).map((b) => [b.address, b]));
    let done = 0;
    const results = await mapWithConcurrency([...FOLLOWED], CONCURRENCY, async (f) => {
      try {
        if (Date.now() - started > DEADLINE_MS) throw new Error("not reached in this scan (time limit)");
        return await readBook(f.address);
      } catch (e) {
        const prev = prevBooks.get(f.address);
        const error = (e as Error).message;
        console.error(`[perp-scout] ${f.address} positions: ${error}`);
        return {
          book: { address: f.address, readAt: prev?.readAt ?? null, error, accountValue: prev?.accountValue ?? null, leverage: prev?.leverage ?? null, bias: prev?.bias ?? null, positions: prev?.positions ?? 0 },
          entries: prevEntries.get(f.address) ?? [],
        };
      } finally {
        progress({ stage: "positions", done: ++done, total: FOLLOWED.length });
      }
    });
    progress({ stage: "saving" });
    const scan: ScoutScan = { scannedAt: new Date().toISOString(), books: results.map((r) => r.book), entries: results.flatMap((r) => r.entries) };
    const { error } = await serviceDb().from("app_settings").upsert({ key: SETTING, value: { scan }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Perp Scout not saved: ${error.message}`);
    const failed = results.filter((r) => r.book.error).length;
    console.log(`[perp-scout] scan ${Math.round((Date.now() - started) / 1000)}s traders=${FOLLOWED.length} failed=${failed} entries=${scan.entries.length}`);
    return { status: "done", failed };
  } finally {
    await claim.release().catch(() => {});
  }
}
