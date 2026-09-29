import "server-only";
import { serviceDb } from "./supabase";
import { claimWatchedAddresses, type WatchedKey } from "./watchRefresh";
import { JOB_STALE_MS, SCHEDULED_STATUS } from "./jobStatus";

// Wallet Watch's daily read as lanes of one-address invocations (2026-09-29,
// Fable's review): the cron used to read every due address inside one
// 300 s function — 24 addresses at ~100 s each, 2 at a time, could never fit
// (4 of 24 were read; 20 stayed claimed and a day behind). Now the cron only
// starts each lane's workers; a worker (api/wallet-watch/read) claims the
// next due address of its lane just before reading it, reads it in its own
// invocation, then starts the next link. A lane per rate-limited API family
// keeps the calls within their limits — the pacers (Jupiter, Etherscan) are
// per process, and each invocation is its own process.

export type ReadLane = "evm" | "solana" | "other";

/** Workers per lane: EVM reads share Etherscan's 3/s and Alchemy's CU/s;
 * Solana's share Jupiter's 1 call/1.1 s — one at a time. */
export const LANE_WORKERS: Record<ReadLane, number> = { evm: 2, solana: 1, other: 1 };

export function laneOf(chain: string): ReadLane {
  return chain === "ETH" ? "evm" : chain === "SOL" ? "solana" : "other";
}

/** The next due address of a lane, claimed (compare-and-set), or null when
 * the lane is done. Only addresses someone still watches. */
export async function claimNextInLane(lane: ReadLane, marker: "syncing" | typeof SCHEDULED_STATUS = SCHEDULED_STATUS): Promise<WatchedKey | null> {
  const db = serviceDb();
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
  let q = db
    .from("watched_addresses")
    .select("chain, address")
    .lte("next_refresh_at", new Date().toISOString())
    .or(`refresh_status.not.in.(syncing,${SCHEDULED_STATUS}),refresh_status.is.null,refresh_started_at.lt.${staleBefore}`)
    .order("next_refresh_at")
    .limit(10);
  q = lane === "evm" ? q.eq("chain", "ETH") : lane === "solana" ? q.eq("chain", "SOL") : q.not("chain", "in", "(ETH,SOL)");
  const [{ data: due, error }, { data: watchedBy, error: watchedError }] = await Promise.all([q, db.from("watch_influencer_addresses").select("chain, address")]);
  if (error || watchedError) throw new Error((error ?? watchedError)!.message);
  const watched = new Set((watchedBy as WatchedKey[]).map((k) => `${k.chain}|${k.address}`));
  for (const k of due as WatchedKey[]) {
    if (!watched.has(`${k.chain}|${k.address}`)) continue;
    const [claimed] = await claimWatchedAddresses([k], marker);
    if (claimed) return claimed;
  }
  return null;
}

/** Starts one worker link (api/wallet-watch/read): the route answers at once
 * and reads inside after(), so this only waits for the hand-off. */
export async function startReadWorker(lane: ReadLane): Promise<void> {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!site || !secret) throw new Error("NEXT_PUBLIC_SITE_URL and CRON_SECRET are needed to start a read worker");
  const res = await fetch(`${site}/api/wallet-watch/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lane }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Read worker (${lane}) not started: HTTP ${res.status}`);
}
