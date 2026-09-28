import "server-only";
import { serviceDb } from "./supabase";
import { fetchTradingRecord } from "./adapters/solanaTracker";
import type { StoredTradingRecord } from "./tradingRecord";

// Loads influencers' trading records on demand (tradingRecord.ts): two
// Solana Tracker requests per Solana address plus its coins — a year of them
// the first time (up to 25 pages), only newer ones after — saved on the shared
// watched_addresses row. A record under RECORD_REUSE_MS old is reused, so
// repeated clicks (or several watchers) don't spend the 2,500 a month.

export const RECORD_REUSE_MS = 60 * 60 * 1000;

export interface RecordLoadOutcome {
  address: string;
  status: "loaded" | "reused" | "error";
  error?: string;
}

export async function loadTradingRecords(addresses: readonly string[], nowMs: number): Promise<RecordLoadOutcome[]> {
  if (addresses.length === 0) return [];
  const db = serviceDb();
  const { data, error } = await db.from("watched_addresses").select("address, trading_record, trading_record_at").eq("chain", "SOL").in("address", addresses);
  if (error) throw new Error(`Failed to load addresses: ${error.message}`);
  const out: RecordLoadOutcome[] = [];
  // One address at a time: the free plan allows 3 requests a second.
  for (const row of data as { address: string; trading_record: StoredTradingRecord | null; trading_record_at: string | null }[]) {
    if (row.trading_record_at && nowMs - Date.parse(row.trading_record_at) < RECORD_REUSE_MS) {
      out.push({ address: row.address, status: "reused" });
      continue;
    }
    try {
      const record = await fetchTradingRecord(row.address, row.trading_record, nowMs);
      const { error: saveError } = await db
        .from("watched_addresses")
        .update({ trading_record: record, trading_record_at: new Date(nowMs).toISOString(), trading_record_status: "ok" })
        .eq("chain", "SOL")
        .eq("address", row.address);
      if (saveError) throw new Error(saveError.message);
      out.push({ address: row.address, status: "loaded" });
    } catch (e) {
      const message = (e as Error).message;
      // The previous record (if any) stays; only the status says what failed.
      await db.from("watched_addresses").update({ trading_record_status: `error: ${message}` }).eq("chain", "SOL").eq("address", row.address);
      out.push({ address: row.address, status: "error", error: message });
    }
  }
  return out;
}
