"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { deriveJobStatus } from "@/lib/jobStatus";
import type { PriceRefreshPhases } from "@/lib/queries";
import { notifyJobsComplete } from "./jobActions";

interface JobPollerContextValue {
  register: (id: string, busy: boolean, pollMs: number) => void;
  unregister: (id: string) => void;
  tick: number;
}

const JobPollerContext = createContext<JobPollerContextValue | null>(null);

interface JobStatusRow {
  status: string | null;
  started_at: string | null;
}

interface WalletJobRow {
  id: string;
  last_refresh_status: string | null;
  sync_started_at: string | null;
  tx_sync_status: string | null;
  tx_sync_started_at: string | null;
  defi_sync_status: string | null;
  defi_sync_started_at: string | null;
  exchange_sync_status: string | null;
  exchange_sync_started_at: string | null;
}

interface JobStatusResponse {
  wallets: WalletJobRow[];
  // phases: per-lane (CoinGecko/Coinbase-Jupiter/EVM) running/done/error +
  // elapsed ms, written progressively as each lane actually finishes (see
  // prices.ts's refreshPrices) — what lets this provider notify as soon as
  // the fast CoinGecko lane lands, instead of waiting for the whole row's
  // `status` to flip once the slower Coinbase/Jupiter lane is also done.
  priceRefresh: (JobStatusRow & { phases: PriceRefreshPhases | null }) | null;
  tokenRegistry: JobStatusRow | null;
}

/** Every distinct job the app tracks, flattened to one row each, from one
 * /api/job-status response — a wallet contributes up to four (holdings/
 * tx/defi/exchange), each independent per holdings.source's own "four
 * disjoint job columns on one row" doc comment. */
function flattenJobs(data: JobStatusResponse): JobStatusRow[] {
  const jobs: JobStatusRow[] = [];
  for (const w of data.wallets) {
    jobs.push({ status: w.last_refresh_status, started_at: w.sync_started_at });
    jobs.push({ status: w.tx_sync_status, started_at: w.tx_sync_started_at });
    jobs.push({ status: w.defi_sync_status, started_at: w.defi_sync_started_at });
    jobs.push({ status: w.exchange_sync_status, started_at: w.exchange_sync_started_at });
  }
  if (data.priceRefresh) jobs.push(data.priceRefresh);
  if (data.tokenRegistry) jobs.push(data.tokenRegistry);
  return jobs;
}

/**
 * One shared polling loop per page (mounted once in (app)/layout.tsx),
 * not one setInterval per busy button — real problem this avoids: "Sync
 * all wallets" can leave a dozen job buttons busy at once, and a dozen
 * independent timers would each poll on their own schedule, firing many
 * more requests per second than any of them individually asked for. Every
 * useJob() call registers its own busy/pollMs here; the provider runs a
 * single interval at the fastest pollMs any currently-busy job requested,
 * and stops entirely once none are busy.
 *
 * Each tick fetches /api/job-status (a cheap Route Handler, not
 * router.refresh() — see that route's own doc comment for why: it runs
 * outside the Server-Action/navigation dispatch queue, so it can never
 * queue up behind a user's own click the way a `router.refresh()` loop
 * did). Whether *anything at all* is running, aggregated across every job
 * in the response, is tracked poll-to-poll; the moment that flips from
 * true to false, this calls notifyJobsComplete() once — a real Server
 * Action whose own response carries the client Router Cache purge every
 * open tab needs (see jobActions.ts's own doc comment for why that has to
 * be a live, synchronous call, not something fired from inside a job's own
 * background after()). Next.js then automatically refetches and patches
 * the current tree as part of that same call — no separate
 * router.refresh() needed.
 *
 * Also fires on the very first poll if a job is already locally "busy" at
 * that point (a button's own optimistic state, set the instant it was
 * clicked — see useJob.ts) but the fresh server snapshot shows nothing
 * running: a job that finishes faster than one poll interval would
 * otherwise never trigger this at all, since there'd be no earlier poll to
 * compare against, leaving its button stuck showing "Syncing…" until
 * something unrelated happened to refresh the page.
 *
 * Also pauses while the tab is hidden (no point polling a page nobody's
 * looking at) and polls once immediately when the tab becomes visible/
 * focused again, so a job that finished while this tab was in the
 * background is picked up right away instead of waiting for the next
 * scheduled tick.
 */
export function JobPollerProvider({ children }: { children: ReactNode }) {
  const jobsRef = useRef(new Map<string, { busy: boolean; pollMs: number }>());
  // null = no poll has landed yet. Otherwise: was *any* job running as of
  // the last poll this provider actually saw.
  const lastAnyRunningRef = useRef<boolean | null>(null);
  // Per-lane status as of the last poll (price_refresh_state.phases) —
  // separate from lastAnyRunningRef's single aggregate boolean, since a
  // price refresh's 3 lanes finish at genuinely different times and each
  // one landing should refresh the page on its own, not just once every
  // lane is done. Keyed by phase name ("coingecko", "coinbase", "evm").
  const lastPhaseStatusRef = useRef<Record<string, string | undefined>>({});
  const [minPollMs, setMinPollMs] = useState<number | null>(null);
  // Increments on every poll (and every visibility-driven refresh) so
  // useNow() can re-read Date.now() in step with real server data landing,
  // not just when the polled row's own fields happen to change — a job
  // stuck at "syncing" forever (its after() killed mid-run) has fields
  // that never change, so without this tick "now" would freeze at the
  // moment the claim was first observed and staleness could never fire.
  const [tick, setTick] = useState(0);

  const recompute = useCallback(() => {
    let min: number | null = null;
    for (const { busy, pollMs } of jobsRef.current.values()) {
      if (busy) min = min === null ? pollMs : Math.min(min, pollMs);
    }
    setMinPollMs(min);
  }, []);

  const register = useCallback(
    (id: string, busy: boolean, pollMs: number) => {
      jobsRef.current.set(id, { busy, pollMs });
      recompute();
    },
    [recompute],
  );

  const unregister = useCallback(
    (id: string) => {
      jobsRef.current.delete(id);
      recompute();
    },
    [recompute],
  );

  useEffect(() => {
    if (minPollMs === null) return;

    async function poll() {
      if (document.hidden) return;
      let data: JobStatusResponse;
      try {
        const res = await fetch("/api/job-status", { cache: "no-store" });
        if (!res.ok) return;
        data = await res.json();
      } catch {
        return; // best-effort — a failed poll just tries again next tick
      }

      const now = Date.now();
      const anyRunningNow = flattenJobs(data).some((row) => deriveJobStatus(row, now).running);
      const wasRunning = lastAnyRunningRef.current;
      // A locally-optimistic button (clicked, hasn't yet seen server
      // confirmation) counts as "was running" too — covers a job that
      // finished before this provider ever got a first poll in (see this
      // component's own doc comment on the fast-job edge case).
      const localBusy = [...jobsRef.current.values()].some((j) => j.busy);
      const treatAsWasRunning = wasRunning ?? localBusy;

      // Same "was running" edge case as above, applied per-lane: a lane
      // this provider has never observed before (prevStatus undefined) —
      // e.g. it finished between the click and this provider's first
      // poll — still counts as "just finished" when the job as a whole
      // was already known/assumed running, so a fast CoinGecko lane can't
      // silently miss its own completion notification.
      let anyPhaseJustFinished = false;
      const phases = data.priceRefresh?.phases;
      if (phases) {
        for (const [name, phase] of Object.entries(phases)) {
          const prevStatus = lastPhaseStatusRef.current[name];
          const wasRunningPrev = prevStatus === "running" || (prevStatus === undefined && treatAsWasRunning);
          if (wasRunningPrev && phase.status !== "running") anyPhaseJustFinished = true;
          lastPhaseStatusRef.current[name] = phase.status;
        }
      }

      lastAnyRunningRef.current = anyRunningNow;
      setTick((t) => t + 1);

      // Two independent triggers, not mutually exclusive: a lane finishing
      // mid-refresh notifies immediately (this is the whole point — prices
      // that are already correct in the DB shouldn't sit unrendered for
      // however long the slowest remaining lane takes), and the job as a
      // whole finishing notifies again as the final, definitely-complete
      // signal. Calling notifyJobsComplete() more than once in the same
      // tick (both can fire together, e.g. the last lane finishing) is
      // harmless — it's just a revalidatePath call.
      if (anyPhaseJustFinished) await notifyJobsComplete();
      if (treatAsWasRunning && !anyRunningNow) await notifyJobsComplete();
    }

    void poll();
    const interval = setInterval(poll, minPollMs);

    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [minPollMs]);

  return <JobPollerContext.Provider value={{ register, unregister, tick }}>{children}</JobPollerContext.Provider>;
}

let nextId = 0;

/** Registers one job's busy/pollMs with the page's JobPollerProvider for
 * as long as the calling component is mounted and `busy` is true. Silently
 * a no-op if no provider is mounted (defensive — every page under (app)/
 * has one via the root layout, but this shouldn't hard-crash a page that
 * somehow doesn't). */
export function useJobPolling(busy: boolean, pollMs: number): void {
  const ctx = useContext(JobPollerContext);
  const idRef = useRef<string>(undefined);
  if (idRef.current === undefined) idRef.current = `job-${nextId++}`;

  useEffect(() => {
    if (!ctx) return;
    const id = idRef.current!;
    ctx.register(id, busy, pollMs);
    return () => ctx.unregister(id);
  }, [ctx, busy, pollMs]);
}

/** The shared poller's tick counter — increments each time it actually
 * polls (or refreshes on visibility return). See useNow() in
 * useJobStatus.ts, the reason this exists: a job stuck at "syncing"
 * forever has row fields that never change on their own, so re-reading
 * Date.now() needs to be driven by real poll events, not by those fields
 * changing. Returns 0 (never advances) if no provider is mounted. */
export function useJobPollerTick(): number {
  return useContext(JobPollerContext)?.tick ?? 0;
}
