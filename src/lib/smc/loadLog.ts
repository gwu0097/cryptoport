import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { serviceDb } from "@/lib/supabase";

// Temporary measurement (2026-09-24): one row per /signals section load in
// public.signals_load_log, so a day of real production traffic can be
// replayed through candleCache.ts's planner to get the hit rate an
// in-memory cache WOULD have had per serverless instance vs a shared
// (Supabase) cache — the numbers that decide which one ships (the cache
// itself is held on hold/signals-ratelimit). Drop the table and this file
// once decided. Written in after(): never adds latency or fails a page.

/** This server instance: a module is loaded once per instance, so every row
 * with the same id shares one process's memory (what an in-memory cache sees). */
const INSTANCE_ID = randomUUID();
const INSTANCE_STARTED_AT = new Date().toISOString();

/** Hyperliquid spend of one section: candleSnapshot weight (20 + 1 per 60
 * candles, per response) and how many 429s were hit (each one retried). */
export interface LoadMeter {
  weight: number;
  http429: number;
}
export const newLoadMeter = (): LoadMeter => ({ weight: 0, http429: 0 });

export function logSignalsLoad(row: {
  section: "chart" | "watchlist";
  ind: string;
  tf: string;
  coins: string[];
  meter: LoadMeter;
  startedAtMs: number;
}) {
  const record = {
    instance_id: INSTANCE_ID,
    instance_started_at: INSTANCE_STARTED_AT,
    section: row.section,
    ind: row.ind,
    tf: row.tf,
    coins: row.coins,
    weight: row.meter.weight,
    http429: row.meter.http429,
    duration_ms: Date.now() - row.startedAtMs,
  };
  console.log(`[signals-load] ${JSON.stringify(record)}`);
  after(async () => {
    const { error } = await serviceDb().from("signals_load_log").insert(record);
    if (error) console.warn(`[signals-load] insert failed: ${error.message}`);
  });
}
