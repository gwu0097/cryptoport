"use client";

import { useEffect, useState, useTransition } from "react";
import type { JobStatus, JobStartResult } from "@/lib/jobStatus";
import { useJobPolling } from "./JobPoller";

const DEFAULT_POLL_MS = 2500;

/**
 * The shared "click a button, it locks, shows real progress for the
 * actual duration of a backgrounded job, then unlocks with the result"
 * behavior — used by every sync/refresh button in this app instead of
 * each one hand-rolling its own version (which is what produced two real,
 * reported bugs: a button that unlocked the instant the network request
 * finished even though the real work kept running in the background for
 * another 10-30s, and a live-progress display that depended on catching a
 * server flag on the exact right render, which silently stopped working
 * once that flag's write moved to a faster path).
 *
 * `status` is the server-rendered JobStatus for this job (see
 * lib/jobStatus.ts's deriveJobStatus) — a plain prop, not fetched here;
 * it updates whenever the page re-renders, including on every poll this
 * hook itself schedules while busy.
 *
 * `busy` is client-owned, not "whatever the server prop says" — captured
 * at the moment `submit()` is called (`baseline = status.startedAt`, the
 * value *before* this click's own claim can have landed), so it's true
 * immediately on click, stays true while `status.running` is true, and
 * only clears once the server prop shows a startedAt that's actually
 * different from the pre-click baseline (proof this click's own claim
 * both landed and finished) — never by racing to observe an intermediate
 * "syncing" state on some specific render, which is what broke before.
 */
export function useJob({
  status,
  start,
  pollMs = DEFAULT_POLL_MS,
}: {
  status: JobStatus;
  start: () => Promise<JobStartResult>;
  pollMs?: number;
}) {
  // undefined = no submission from this component instance in flight;
  // otherwise the status.startedAt captured right before submitting.
  const [baseline, setBaseline] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const awaitingMyRun = baseline !== undefined && status.startedAt === baseline;
  const busy = isPending || status.running || awaitingMyRun;

  function submit() {
    setError(null);
    setBaseline(status.startedAt);
    startTransition(async () => {
      try {
        const result = await start();
        if (!result.started) {
          setError(result.reason);
          setBaseline(undefined);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
        setBaseline(undefined);
      }
    });
  }

  // Synchronizing local "am I waiting on my own submission" state with the
  // server's own confirmation that it landed and finished — not deriving
  // state that could be computed during render, same exception
  // usePersistedState.ts's own identical read-on-effect already documents.
  useEffect(() => {
    if (baseline !== undefined && !status.running && status.startedAt !== baseline) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBaseline(undefined);
    }
  }, [status.running, status.startedAt, baseline]);

  useJobPolling(busy && !isPending, pollMs);

  return { busy, isPending, error, submit };
}
