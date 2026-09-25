"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { deriveJobStatus, type JobStartResult } from "@/lib/jobStatus";
import { groupByLane } from "@/lib/syncLanes";
import { primeSyncPricesAction, syncExchangeHoldings, syncWalletHoldings } from "@/app/(app)/wallets/actions";
import { notifyJobsComplete } from "./jobActions";

export interface QueuedWallet {
  id: string;
  name: string;
  lane: string;
  provider: string | null;
}

export type QueueEntryState = "queued" | "running" | "ok" | "partial" | "failed";

export interface QueueEntry {
  name: string;
  state: QueueEntryState;
  /** The wallet's own status line (a partial/failed reason). */
  detail: string | null;
}

interface SyncQueueValue {
  entries: Record<string, QueueEntry>;
  /** True while any lane still has work. */
  active: boolean;
  start: (wallets: QueuedWallet[]) => void;
  dismiss: () => void;
}

const SyncQueueContext = createContext<SyncQueueValue | null>(null);

const POLL_MS = 3_000;

// Wallets in flight at once per lane (default 1). EVM starts at 2: one at a
// time had no Arbitrum failures, twelve at once had 800–2,000 per wallet
// (2026-09-25); raise it if a Sync all's statuses stay clean at 2.
const LANE_CONCURRENCY: Record<string, number> = { evm: 2 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface JobStatusWallet {
  id: string;
  last_refresh_status: string | null;
  sync_started_at: string | null;
  exchange_sync_status: string | null;
  exchange_sync_started_at: string | null;
}

/** Waits for one wallet's claimed sync to finish; its final status row. */
async function waitForWallet(w: QueuedWallet): Promise<{ status: string | null; started_at: string | null }> {
  for (;;) {
    await sleep(POLL_MS);
    try {
      const res = await fetch("/api/job-status", { cache: "no-store" });
      if (!res.ok) continue;
      const body: { wallets: JobStatusWallet[] } = await res.json();
      const row = body.wallets.find((x) => x.id === w.id);
      if (!row) return { status: "error: wallet no longer active", started_at: null };
      const job = w.provider
        ? { status: row.exchange_sync_status, started_at: row.exchange_sync_started_at }
        : { status: row.last_refresh_status, started_at: row.sync_started_at };
      if (!deriveJobStatus(job, Date.now()).running) return job;
    } catch {
      // a failed poll just tries again
    }
  }
}

/**
 * "Sync all", run from the browser as a queue (mounted once, in
 * (app)/layout.tsx, so it keeps going across page changes). Wallets that
 * share a rate-limited API go one at a time in their lane (lib/syncLanes.ts:
 * every EVM wallet, every Solana wallet, the Cosmos scans; EVM two at a
 * time, see LANE_CONCURRENCY); lanes run side by side. Each wallet is its
 * own sync request, so each gets the route's full time budget — a
 * 50-wallet portfolio no longer has to fit in one.
 *
 * After each wallet finishes the page refreshes (notifyJobsComplete), so its
 * row shows its result right away instead of when the whole batch is done.
 * Closing the tab stops wallets that haven't started (the running one still
 * finishes on the server), so the tab asks before closing while it runs.
 */
export function SyncQueueProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, QueueEntry>>({});
  const [active, setActive] = useState(false);
  const runningRef = useRef(false);

  const set = useCallback((id: string, patch: Partial<QueueEntry>) => {
    setEntries((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  const runOne = useCallback(
    async (w: QueuedWallet) => {
      set(w.id, { state: "running" });
      let started: JobStartResult;
      try {
        started = w.provider ? await syncExchangeHoldings(w.id) : await syncWalletHoldings(w.id, false);
      } catch (e) {
        set(w.id, { state: "failed", detail: (e as Error).message });
        return;
      }
      // "Already syncing" (another tab, a row click): wait for that run.
      if (!started.started && !/already/i.test(started.reason)) {
        set(w.id, { state: "failed", detail: started.reason });
        return;
      }
      const final = await waitForWallet(w);
      const outcome = deriveJobStatus(final, Date.now()).outcome;
      set(w.id, {
        state: outcome === "ok" ? "ok" : outcome === "partial" ? "partial" : "failed",
        detail: outcome === "ok" ? null : final.status,
      });
      await notifyJobsComplete().catch(() => {});
    },
    [set],
  );

  const start = useCallback(
    (wallets: QueuedWallet[]) => {
      if (runningRef.current || wallets.length === 0) return;
      runningRef.current = true;
      setActive(true);
      setEntries(Object.fromEntries(wallets.map((w) => [w.id, { name: w.name, state: "queued" as const, detail: null }])));
      const lanes = groupByLane(wallets, (w) => w.lane);
      const runLanes = () =>
        Promise.all(
          lanes.flatMap((lane) => {
            // N workers pulling from the lane's list, in order.
            let next = 0;
            const workers = Math.min(LANE_CONCURRENCY[lane[0].lane] ?? 1, lane.length);
            return Array.from({ length: workers }, async () => {
              while (next < lane.length) await runOne(lane[next++]);
            });
          }),
        );
      void (async () => {
        try {
          // Every held coin priced once before the first wallet (see
          // primeSyncPricesAction), so the wallets reuse those prices.
          await primeSyncPricesAction().catch(() => {});
          await runLanes();
        } finally {
          runningRef.current = false;
          setActive(false);
        }
      })();
    },
    [runOne],
  );

  const dismiss = useCallback(() => {
    if (!runningRef.current) setEntries({});
  }, []);

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  return <SyncQueueContext.Provider value={{ entries, active, start, dismiss }}>{children}</SyncQueueContext.Provider>;
}

export function useSyncQueue(): SyncQueueValue {
  const ctx = useContext(SyncQueueContext);
  if (!ctx) throw new Error("useSyncQueue outside SyncQueueProvider");
  return ctx;
}

/** This wallet's place in the current Sync all run, if it's in one. */
export function useQueueEntry(walletId: string): QueueEntry | null {
  return useContext(SyncQueueContext)?.entries[walletId] ?? null;
}
