import "server-only";
import { serviceDb } from "./supabase";
import { mapWithConcurrency } from "./adapters/http";
import { resolveTickerIcons } from "./adapters/coingecko";
import { fetchAccountState, fetchOpenOrders, fetchPortfolio, fetchRecentFills } from "./adapters/hyperliquidScout";
import { traderStats, type TraderStats } from "./perpScout/portfolio";
import { accountLeverage, buildEntries, netBias, type ScoutEntry } from "./perpScout/entries";
import { FOLLOWED, MAX_FOLLOWED, isTraderAddress, mergeFollowed, type FollowedTrader } from "./perpScout/followed";

// Perp Scout's scan (docs/perp-scout/PLAN.md): the open positions, latest
// fills and TP/SL orders of the traders in followed.ts and those the owner
// added on the page (ADDED_SETTING) — a list curated in
// chat, not found by the app (owner 2026-10-06). Public market data, one
// shared app_settings row (SETTING) every viewer reads; one scan at a time
// (RUN_SETTING, compare-and-set).

const SETTING = "perp_scout";
/** The owner's changes on the page: traders added, and addresses removed
 * (`{ traders: FollowedTrader[], removed: string[] }`) — a code-list trader
 * removed there stays in followed.ts but isn't scanned or shown. */
const ADDED_SETTING = "perp_scout_added";
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
  /** The whole account's value (perps + spot); the perps side's when the
   * record couldn't be read. */
  accountValue: number | null;
  /** Its perps record as of this read; null when it couldn't be read. */
  stats?: TraderStats | null;
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

export interface PerpScoutState {
  /** The last scan, limited to the traders still on the list. */
  scan: ScoutScan | null;
  /** The list: followed.ts, then the traders added on the page. */
  traders: FollowedTrader[];
}

interface ListChanges {
  added: FollowedTrader[];
  removed: string[];
}

async function readRows(): Promise<{ scan: ScoutScan | null } & ListChanges> {
  const { data, error } = await serviceDb().from("app_settings").select("key, value").in("key", [SETTING, ADDED_SETTING]);
  if (error) throw new Error(error.message);
  const byKey = new Map((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  const changes = (byKey.get(ADDED_SETTING) ?? null) as { traders?: FollowedTrader[]; removed?: string[] } | null;
  return {
    scan: ((byKey.get(SETTING) ?? null) as { scan?: ScoutScan } | null)?.scan ?? null,
    added: changes?.traders ?? [],
    removed: changes?.removed ?? [],
  };
}

/** Everything the page shows, in one request. */
export async function readPerpScout(): Promise<PerpScoutState> {
  const { scan, added, removed } = await readRows();
  const traders = mergeFollowed(FOLLOWED, added, removed);
  const listed = new Set(traders.map((f) => f.address));
  return {
    scan: scan && { ...scan, books: scan.books.filter((b) => listed.has(b.address)), entries: scan.entries.filter((e) => listed.has(e.address)) },
    traders,
  };
}

/**
 * Adds a trader by address (owner only — checked by the route): reads its
 * perps record once (portfolio, weight 20) for the figures it's added on;
 * an address with no perps history on Hyperliquid isn't added.
 */
export async function addTrader(rawAddress: string, rawName: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const address = rawAddress.trim().toLowerCase();
  if (!isTraderAddress(address)) return { ok: false, error: "Not a Hyperliquid address (0x and 40 hex characters)" };
  const { added, removed } = await readRows();
  const traders = mergeFollowed(FOLLOWED, added, removed);
  if (traders.some((f) => f.address === address)) return { ok: false, error: "Already on the list" };
  // A code-list trader removed earlier comes back as it was.
  if (FOLLOWED.some((f) => f.address === address)) {
    await saveChanges({ added, removed: removed.filter((a) => a !== address) });
    return { ok: true };
  }
  if (traders.length >= MAX_FOLLOWED) return { ok: false, error: `The list is full (${MAX_FOLLOWED}) — remove one first` };
  let stats: TraderStats;
  try {
    stats = traderStats(await fetchPortfolio(address), Date.now());
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: /no perps history/.test(msg) ? "No perp trading history on Hyperliquid for this address" : `Couldn't read it from Hyperliquid: ${msg}` };
  }
  const today = new Date().toISOString().slice(0, 10);
  const trader: FollowedTrader = {
    address,
    name: rawName?.trim().slice(0, 40) || `${address.slice(0, 6)}…${address.slice(-4)}`,
    addedOn: today,
    why: `Added by address on the page, ${today}`,
    picked: {
      asOf: today,
      equity: stats.equityNow,
      typicalEquity: stats.typicalEquity,
      allTimePnl: stats.totalPnl,
      monthPnl: stats.monthPnl,
      historyMonths: Math.round(stats.historyWeeks / 4.35),
      winningWeeks: stats.winningWeeksShare,
      drawdownShare: stats.drawdownShare,
      bestFourShare: stats.bestFourShare,
    },
  };
  await saveChanges({ added: [...added, trader], removed: removed.filter((a) => a !== address) });
  return { ok: true };
}

/** Removes a trader from the list: one added on the page is deleted; one
 * from followed.ts is hidden (re-adding its address brings it back). */
export async function removeTrader(rawAddress: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const address = rawAddress.trim().toLowerCase();
  const { added, removed } = await readRows();
  if (!mergeFollowed(FOLLOWED, added, removed).some((f) => f.address === address)) return { ok: false, error: "Not on the list" };
  const inCode = FOLLOWED.some((f) => f.address === address);
  await saveChanges({ added: added.filter((f) => f.address !== address), removed: inCode ? [...new Set([...removed, address])] : removed });
  return { ok: true };
}

async function saveChanges({ added, removed }: ListChanges): Promise<void> {
  const { error } = await serviceDb().from("app_settings").upsert({ key: ADDED_SETTING, value: { traders: added, removed }, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Perp Scout list not saved: ${error.message}`);
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

/** The symbol a perp's logo is looked up by: Hyperliquid quotes some coins
 * per thousand ("kPEPE" is 1,000 PEPE). */
const iconTicker = (coin: string) => (/^k[A-Z]/.test(coin) ? coin.slice(1) : coin);

/** One account's book: its record and whole-account value (portfolio, a
 * failure leaves them unknown), positions, and — only with a position — its
 * fills and orders. */
async function readBook(address: string): Promise<{ book: ScoutBook; entries: ScoutEntry[] }> {
  const [state, series] = await Promise.all([fetchAccountState(address), fetchPortfolio(address).catch((e: Error) => e)]);
  const stats = series instanceof Error ? null : traderStats(series, Date.now());
  if (series instanceof Error) console.error(`[perp-scout] ${address} record: ${series.message}`);
  const open = state.assetPositions.some(({ position }) => Number(position.szi) !== 0);
  const [fills, orders] = open ? await Promise.all([fetchRecentFills(address), fetchOpenOrders(address).catch(() => null)]) : [[], null];
  const perpsValue = Number(state.marginSummary?.accountValue);
  const equity = stats?.equityNow ?? (Number.isFinite(perpsValue) ? perpsValue : null);
  const entries = buildEntries(address, state, fills, orders, equity);
  return {
    book: { address, readAt: new Date().toISOString(), error: null, accountValue: equity, stats, leverage: accountLeverage(state, equity), bias: netBias(entries), positions: entries.length },
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
  const { scan: before, added, removed } = await readRows();
  const following = mergeFollowed(FOLLOWED, added, removed);
  if (following.length === 0) return { status: "none", failed: 0 };
  const sameList = before && before.books.length === following.length && following.every((f) => before.books.some((b) => b.address === f.address));
  if (sameList && started - Date.parse(before.scannedAt) < FRESH_MS) return { status: "fresh", failed: 0 };
  const claim = await claimRun();
  if (!claim.ok) return { status: "busy", failed: 0 };
  try {
    const prevEntries = new Map<string, ScoutEntry[]>();
    for (const e of before?.entries ?? []) prevEntries.set(e.address, [...(prevEntries.get(e.address) ?? []), e]);
    const prevBooks = new Map((before?.books ?? []).map((b) => [b.address, b]));
    let done = 0;
    const results = await mapWithConcurrency(following, CONCURRENCY, async (f) => {
      try {
        if (Date.now() - started > DEADLINE_MS) throw new Error("not reached in this scan (time limit)");
        return await readBook(f.address);
      } catch (e) {
        const prev = prevBooks.get(f.address);
        const error = (e as Error).message;
        console.error(`[perp-scout] ${f.address} positions: ${error}`);
        return {
          book: { address: f.address, readAt: prev?.readAt ?? null, error, accountValue: prev?.accountValue ?? null, stats: prev?.stats ?? null, leverage: prev?.leverage ?? null, bias: prev?.bias ?? null, positions: prev?.positions ?? 0 },
          entries: prevEntries.get(f.address) ?? [],
        };
      } finally {
        progress({ stage: "positions", done: ++done, total: following.length });
      }
    });
    progress({ stage: "saving" });
    const entries = results.flatMap((r) => r.entries);
    // Logos through the app's icon cache (ticker_icons; CoinGecko only for a
    // ticker never seen) — cosmetic, so a failure just leaves letter badges.
    const icons = await resolveTickerIcons(entries.map((e) => iconTicker(e.coin))).catch(() => new Map<string, string>());
    for (const e of entries) e.iconUrl = icons.get(iconTicker(e.coin).toUpperCase()) ?? null;
    const scan: ScoutScan = { scannedAt: new Date().toISOString(), books: results.map((r) => r.book), entries };
    const { error } = await serviceDb().from("app_settings").upsert({ key: SETTING, value: { scan }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Perp Scout not saved: ${error.message}`);
    const failed = results.filter((r) => r.book.error).length;
    console.log(`[perp-scout] scan ${Math.round((Date.now() - started) / 1000)}s traders=${following.length} failed=${failed} entries=${scan.entries.length}`);
    return { status: "done", failed };
  } finally {
    await claim.release().catch(() => {});
  }
}
