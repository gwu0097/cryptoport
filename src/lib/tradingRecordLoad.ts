import "server-only";
import { serviceDb } from "./supabase";
import { fetchTradingRecord } from "./adapters/solanaTracker";
import { fetchZerionPnl } from "./adapters/zerionDefi";
import { sequentialWithSpacing } from "./adapters/http";
import { zerionRecord, zerionWindows } from "./zerionRecord";
import type { StoredTradingRecord } from "./tradingRecord";

// Loads influencers' trading records on demand (tradingRecord.ts), saved on
// the shared watched_addresses row; a record under RECORD_REUSE_MS old is
// reused, so repeated clicks (or several watchers) cost nothing.
// Solana: two Solana Tracker requests plus its coins — a year of them the
// first time (up to 25 pages), only newer ones after (2,500 a month free).
// EVM (owner 2026-09-30): Zerion's profit and loss (zerionRecord.ts) — the
// first load asks all-time, 30/90 days and 12 months (15 calls), later ones
// only all-time, the windows and the running month (4–5); 1.1 s apart
// (Zerion's 1 a second, shared with wallet syncs; 300 a day free).

export const RECORD_REUSE_MS = 60 * 60 * 1000;

export interface RecordLoadOutcome {
  address: string;
  status: "loaded" | "reused" | "error";
  error?: string;
}

const ZERION_SPACING_MS = 1_100;

/** A Solana record with no trade at all — what a not-yet-indexed answer
 * used to save as $0 (never reused, cleared on the next failed load). */
const emptyRecord = (r: StoredTradingRecord | null) => !!r && r.source !== "zerion" && !r.firstTradeAt && r.days.length === 0;

export async function loadTradingRecords(addresses: readonly { chain: string; address: string }[], nowMs: number): Promise<RecordLoadOutcome[]> {
  const wanted = addresses.filter((a) => a.chain === "SOL" || a.chain === "ETH");
  if (wanted.length === 0) return [];
  const db = serviceDb();
  const { data, error } = await db
    .from("watched_addresses")
    .select("chain, address, trading_record, trading_record_at")
    .in("chain", [...new Set(wanted.map((a) => a.chain))])
    .in("address", wanted.map((a) => a.address));
  if (error) throw new Error(`Failed to load addresses: ${error.message}`);
  const out: RecordLoadOutcome[] = [];
  // One address at a time: the free plan allows 3 requests a second.
  for (const row of data as { chain: string; address: string; trading_record: StoredTradingRecord | null; trading_record_at: string | null }[]) {
    if (row.trading_record_at && nowMs - Date.parse(row.trading_record_at) < RECORD_REUSE_MS && !emptyRecord(row.trading_record)) {
      out.push({ address: row.address, status: "reused" });
      continue;
    }
    try {
      const t0 = Date.now();
      let record: StoredTradingRecord;
      if (row.chain === "SOL") {
        const r = await fetchTradingRecord(row.address, row.trading_record, nowMs);
        record = r.record;
        // A first coin load reads a year (up to 25 pages); after it, only coins
        // traded since its cursor — this line shows which it was and how long.
        console.log(`[trading-record] ${row.address} ${r.firstCoinLoad ? "first coin load" : "since last load"} pages=${r.coinPages + 2} coins=+${r.newCoins} ms=${Date.now() - t0}`);
      } else {
        const prev = row.trading_record?.source === "zerion" ? row.trading_record : null;
        const windows = zerionWindows(prev, nowMs);
        const results = await sequentialWithSpacing(windows, ZERION_SPACING_MS, (w) => fetchZerionPnl(row.address, w.kind === "all" ? undefined : { sinceMs: w.sinceMs, tillMs: w.tillMs }));
        const built = zerionRecord(prev, results.map((r) => ({ window: r.item, pnl: r.result ?? null })), nowMs);
        if (!built) throw new Error("Zerion had no answer for this address");
        record = built;
        const missed = results.filter((r) => !r.result).length;
        console.log(`[trading-record] ${row.address} zerion calls=${windows.length}${missed ? ` unanswered=${missed}` : ""} realized=${Math.round(record.realizedUsd)} ms=${Date.now() - t0}`);
      }
      const { error: saveError } = await db
        .from("watched_addresses")
        .update({ trading_record: record, trading_record_at: new Date(nowMs).toISOString(), trading_record_status: "ok" })
        .eq("chain", row.chain)
        .eq("address", row.address);
      if (saveError) throw new Error(saveError.message);
      out.push({ address: row.address, status: "loaded" });
    } catch (e) {
      const message = (e as Error).message;
      // The previous record (if any) stays; only the status says what failed —
      // except an empty one saved from a not-yet-indexed answer (all $0, no
      // trade ever), which was never a record.
      const empty = emptyRecord(row.trading_record);
      await db
        .from("watched_addresses")
        .update({ trading_record_status: `error: ${message}`, ...(empty ? { trading_record: null, trading_record_at: null } : {}) })
        .eq("chain", row.chain)
        .eq("address", row.address);
      out.push({ address: row.address, status: "error", error: message });
    }
  }
  return out;
}
