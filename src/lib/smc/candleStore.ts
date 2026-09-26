import "server-only";
import { after } from "next/server";
import { serviceDb } from "@/lib/supabase";
import type { ChartTimeframe } from "./engine";
import type { Candle } from "./engine";
import type { CandleEntry } from "./candleCache";
import { packCandles, unpackCandles, toByteaHex, fromByteaHex } from "./candlePack";

// The shared tier of the Signals candle cache: cryptoport.hl_candle_cache, one
// row per coin + timeframe (candles packed, candlePack.ts). Every server
// instance reads it before asking Hyperliquid, so a cold instance starts warm.
// Replaying a day and a half of real /signals loads (signals_load_log,
// 2026-09-26): 74% of candle requests answered from a shared cache vs 55% from
// each instance's memory alone, 81% vs 61% less Hyperliquid weight. Size: one
// row per coin+timeframe anyone viewed, each trimmed to its timeframe's window
// (~5-8 MB for the 93 seen); rows unused for UNUSED_DAYS are deleted by the
// daily snapshot cron. Best-effort: a failed read or write only costs a
// Hyperliquid fetch, never a page.

export const UNUSED_DAYS = 14;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000; // bump last_used_at at most daily

type Row = {
  coin: string;
  tf: string;
  bar_seconds: number;
  cover_from_sec: number;
  fetched_at_sec: number;
  candles: string;
  forming: Candle | null;
  last_used_at: string;
};

export async function readEntries(coins: readonly string[], tf: ChartTimeframe): Promise<Map<string, CandleEntry>> {
  const out = new Map<string, CandleEntry>();
  if (coins.length === 0) return out;
  const { data, error } = await serviceDb().from("hl_candle_cache").select("*").eq("tf", tf).in("coin", [...coins]);
  if (error) throw new Error(`candle cache read: ${error.message}`);
  const stale: string[] = [];
  for (const r of data as Row[]) {
    out.set(r.coin, {
      barSeconds: r.bar_seconds,
      completed: unpackCandles(fromByteaHex(r.candles)),
      forming: r.forming,
      coverFromSec: Number(r.cover_from_sec),
      fetchedAtSec: Number(r.fetched_at_sec),
    });
    if (Date.now() - Date.parse(r.last_used_at) > TOUCH_AFTER_MS) stale.push(r.coin);
  }
  if (stale.length > 0) {
    runAfter(async () => {
      await serviceDb().from("hl_candle_cache").update({ last_used_at: new Date().toISOString() }).eq("tf", tf).in("coin", stale);
    });
  }
  return out;
}

export function writeEntries(tf: ChartTimeframe, entries: readonly { coin: string; entry: CandleEntry }[]): void {
  if (entries.length === 0) return;
  const now = new Date().toISOString();
  const rows = entries.map(({ coin, entry }) => ({
    coin,
    tf,
    bar_seconds: entry.barSeconds,
    cover_from_sec: entry.coverFromSec,
    fetched_at_sec: entry.fetchedAtSec,
    candles: toByteaHex(packCandles(entry.completed)),
    forming: entry.forming,
    last_used_at: now,
  }));
  runAfter(async () => {
    const { error } = await serviceDb().from("hl_candle_cache").upsert(rows, { onConflict: "coin,tf" });
    if (error) console.warn(`[signals] candle cache write failed: ${error.message}`);
  });
}

/** Deletes rows nobody has read for UNUSED_DAYS (daily snapshot cron). */
export async function deleteUnusedCandles(): Promise<number> {
  const before = new Date(Date.now() - UNUSED_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await serviceDb().from("hl_candle_cache").delete().lt("last_used_at", before).select("coin");
  if (error) throw new Error(error.message);
  return data.length;
}

/** After the response when there is one (a page render or action); awaited
 * otherwise (a script). */
function runAfter(fn: () => Promise<void>): void {
  const safe = () => fn().catch((e: Error) => console.warn(`[signals] candle cache: ${e.message}`));
  try {
    after(safe);
  } catch {
    void safe();
  }
}
