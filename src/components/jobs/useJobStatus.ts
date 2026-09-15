"use client";

import { useEffect, useState } from "react";
import { deriveJobStatus, type JobStatus } from "@/lib/jobStatus";
import { useJobPollerTick } from "./JobPoller";

/**
 * Client-safe wrapper around deriveJobStatus — calling Date.now() directly
 * in a render body is flagged by React's purity rule (impure function,
 * unstable across re-renders/concurrent rendering) and caught this live
 * while building this feature. `now` starts null and is set via effect
 * instead; `deriveJobStatus` is called with `now ?? 0` in the meantime,
 * which is a safe (not just convenient) fallback: a diff against epoch 0
 * is always deeply negative, so `stale` correctly comes out false on that
 * first paint rather than a wrong guess in either direction.
 *
 * Re-runs the effect (and so re-reads Date.now()) whenever the underlying
 * row's own status/started_at change, AND on every JobPoller tick. The
 * tick is required, not just a nicety: a job stuck at "syncing" forever
 * (its background after() killed mid-run) has row fields that never
 * change on their own — without the tick, `now` would freeze at the
 * moment that claim was first observed, `now - startedAt` would never
 * cross JOB_STALE_MS, `stale` would never flip true, and both the button
 * and JobPoller's own refresh loop would stay stuck indefinitely in an
 * open tab. The tick only advances while something on the page is
 * actually being polled (see JobPollerProvider), so an idle tab still
 * re-renders zero extra times.
 */
export function useJobStatus(row: { status: string | null; started_at: string | null }): JobStatus {
  const now = useNow([row.status, row.started_at]);
  return deriveJobStatus(row, now ?? 0);
}

/**
 * Same Date.now()-in-an-effect trick as useJobStatus, generalized for a
 * caller that derives status from several rows at once (e.g. "is *any*
 * wallet syncing" for a "Sync all" button) rather than one. `deps` decides
 * when to re-read the clock beyond the shared JobPoller tick (folded in
 * automatically below) — pass the values `now` gets compared against so a
 * fresh read also happens right when a poll or server render lands.
 */
export function useNow(deps: readonly unknown[]): number | null {
  const [now, setNow] = useState<number | null>(null);
  const tick = useJobPollerTick();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    // react-hooks/exhaustive-deps can't statically check a spread deps
    // array passed in by the caller — that's the whole point of this
    // hook accepting one, so intentionally not `deps`/`tick` in this
    // comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return now;
}
