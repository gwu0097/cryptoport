import "server-only";
import { serviceDb } from "./supabase";
import { claimWatchedAddresses, type WatchedKey } from "./watchRefresh";
import { JOB_STALE_MS, SCHEDULED_STATUS } from "./jobStatus";

// Wallet Watch's daily read (2026-09-29, Fable's reviews). Supabase pg_cron
// calls api/wallet-watch/tick every minute from 08:00 to 09:59 UTC while an
// address someone watches is due (checked inside Postgres, so a finished run
// costs nothing). Each tick fills each lane's free slots: one
// api/wallet-watch/read call per slot, which claims one due address of its
// lane, reads it and stops. Never a chain of calls — Vercel refuses a
// function calling its own site after ~4 hops (HTTP 508, seen live). Lanes
// keep each API family within its limits; the pacers (Jupiter, Etherscan)
// are per server instance, so concurrency is enforced by the claims.

export type ReadLane = "evm" | "solana" | "other";

/** Reads at once per lane: EVM reads share Etherscan's 3/s and Alchemy's
 * CU/s; Solana's share Jupiter's 10 requests / 10 s — one at a time. */
export const LANE_WORKERS: Record<ReadLane, number> = { evm: 2, solana: 1, other: 1 };

/** A claim this recent that is still claimed: that read is running. */
const RUNNING_MS = 5 * 60_000;
/** A claim that died this recently: the address killed its read (a read
 * past the 300 s limit) — it isn't retried today. */
const DIED_WITHIN_MS = 2 * 60 * 60_000;

export function laneOf(chain: string): ReadLane {
  return chain === "ETH" ? "evm" : chain === "SOL" ? "solana" : "other";
}

const inLane = <T extends { eq: (c: string, v: string) => T; not: (c: string, op: string, v: string) => T }>(q: T, lane: ReadLane): T =>
  lane === "evm" ? q.eq("chain", "ETH") : lane === "solana" ? q.eq("chain", "SOL") : q.not("chain", "in", "(ETH,SOL)");

/** Each lane's free read slots right now: LANE_WORKERS minus its reads
 * running (claimed in the last RUNNING_MS), and only lanes with something
 * due. Two requests. */
export async function freeSlots(): Promise<Record<ReadLane, number>> {
  const db = serviceDb();
  const now = Date.now();
  const [{ data: due, error }, { data: running, error: runningError }] = await Promise.all([
    db.from("watched_addresses").select("chain").lte("next_refresh_at", new Date(now).toISOString()).limit(1000),
    db.from("watched_addresses").select("chain").in("refresh_status", ["syncing", SCHEDULED_STATUS]).gte("refresh_started_at", new Date(now - RUNNING_MS).toISOString()),
  ]);
  if (error || runningError) throw new Error((error ?? runningError)!.message);
  const dueLanes = new Set((due as { chain: string }[]).map((r) => laneOf(r.chain)));
  const busy: Record<ReadLane, number> = { evm: 0, solana: 0, other: 0 };
  for (const r of running as { chain: string }[]) busy[laneOf(r.chain)]++;
  const out: Record<ReadLane, number> = { evm: 0, solana: 0, other: 0 };
  for (const lane of Object.keys(out) as ReadLane[]) out[lane] = dueLanes.has(lane) ? Math.max(0, LANE_WORKERS[lane] - busy[lane]) : 0;
  return out;
}

/** The next due address of a lane, claimed (compare-and-set), or null. Only
 * addresses someone still watches. An address whose claim died within
 * DIED_WITHIN_MS killed its read: it's marked failed and waits for tomorrow,
 * instead of taking the lane's slot all morning. */
export async function claimNextInLane(lane: ReadLane): Promise<WatchedKey | null> {
  const db = serviceDb();
  const now = Date.now();
  const staleBefore = new Date(now - JOB_STALE_MS).toISOString();
  const [{ data: due, error }, { data: watchedBy, error: watchedError }] = await Promise.all([
    inLane(
      db
        .from("watched_addresses")
        .select("chain, address, refresh_status, refresh_started_at")
        .lte("next_refresh_at", new Date(now).toISOString())
        .or(`refresh_status.not.in.(syncing,${SCHEDULED_STATUS}),refresh_status.is.null,refresh_started_at.lt.${staleBefore}`)
        .order("next_refresh_at")
        .limit(10),
      lane,
    ),
    db.from("watch_influencer_addresses").select("chain, address"),
  ]);
  if (error || watchedError) throw new Error((error ?? watchedError)!.message);
  const watched = new Set((watchedBy as WatchedKey[]).map((k) => `${k.chain}|${k.address}`));
  for (const r of due as (WatchedKey & { refresh_status: string | null; refresh_started_at: string | null })[]) {
    if (!watched.has(`${r.chain}|${r.address}`)) continue;
    const died = (r.refresh_status === SCHEDULED_STATUS || r.refresh_status === "syncing") && r.refresh_started_at && now - Date.parse(r.refresh_started_at) < DIED_WITHIN_MS;
    if (died) {
      const status = "error: the read didn't finish (over the 300 s limit) — tried again tomorrow";
      await db
        .from("watched_addresses")
        .update({ refresh_status: status, last_refresh_status: status, next_refresh_at: new Date(now + 20 * 60 * 60_000).toISOString() })
        .eq("chain", r.chain)
        .eq("address", r.address);
      console.error(`[watch-lane] ${lane}: ${r.chain}:${r.address} ${status}`);
      continue;
    }
    const [claimed] = await claimWatchedAddresses([{ chain: r.chain, address: r.address }], SCHEDULED_STATUS);
    if (claimed) return claimed;
  }
  return null;
}

/** Starts one read (api/wallet-watch/read): the route answers at once and
 * reads inside after(), so this only waits for the hand-off. */
export async function startReadWorker(lane: ReadLane): Promise<void> {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!site || !secret) throw new Error("NEXT_PUBLIC_SITE_URL and CRON_SECRET are needed to start a read");
  const res = await fetch(`${site}/api/wallet-watch/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lane }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Read (${lane}) not started: HTTP ${res.status}`);
}
