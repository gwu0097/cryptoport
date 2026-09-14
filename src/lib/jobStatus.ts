// Pure, no DB/network imports — the shared rulebook for "is this
// background job still running" across every one of this app's job-style
// buttons (wallet holdings sync, transaction sync, price refresh, token
// registry refresh, and their "sync all" variants). Each job's own table
// already stores an "in progress" marker string and a started-at
// timestamp (wallets.last_refresh_status/sync_started_at, wallets.
// tx_sync_status/tx_sync_started_at, price_refresh_state.status/
// started_at, ...) — this turns that raw pair into one consistent shape
// instead of every button hand-rolling its own "is it still syncing"
// check the way this app used to.

export type JobOutcome = "ok" | "partial" | "error" | "timed-out" | null;

export interface JobStatus {
  /** Claimed and not stale — the real, current "still working" signal. */
  running: boolean;
  /** Claimed, but past JOB_STALE_MS since it started — almost certainly
   * killed by the platform's own function time limit rather than
   * genuinely still running. Real bug this fixes: without a staleness
   * check, a job whose background task got killed mid-flight left its
   * row saying "in progress" forever, with no way to ever retry it. */
  stale: boolean;
  startedAt: string | null;
  outcome: JobOutcome;
  /** The raw status text this was derived from — callers that want the
   * full detail (e.g. "3/50 ticker(s) failed") show this directly rather
   * than this module inventing a lossy summary. */
  detail: string | null;
}

/** What a job-starting Server Action returns instead of either throwing
 * or silently no-op'ing — `{started: false}` is the normal, expected
 * outcome for "someone/something already claimed this job," not an
 * error. */
export type JobStartResult = { started: true } | { started: false; reason: string };

// Matches this app's existing maxDuration=300 ceiling on every job route
// (wallet sync, tx sync, price refresh all set `export const maxDuration
// = 300`) plus a safety margin for the gap between that budget expiring
// and the platform actually tearing the function down.
export const JOB_STALE_MS = 300_000 + 60_000;

const IN_PROGRESS_STATUSES = new Set(["syncing", "refreshing"]);

export function deriveJobStatus(
  row: { started_at: string | null; status: string | null },
  now: number,
  staleAfterMs: number = JOB_STALE_MS,
): JobStatus {
  const claimed = row.status !== null && IN_PROGRESS_STATUSES.has(row.status);
  const startedMs = row.started_at ? Date.parse(row.started_at) : null;
  const stale = claimed && startedMs !== null && now - startedMs > staleAfterMs;
  const running = claimed && !stale;

  let outcome: JobOutcome = null;
  if (stale) {
    outcome = "timed-out";
  } else if (!claimed && row.status) {
    if (row.status.startsWith("error:")) outcome = "error";
    else if (row.status.startsWith("partial") || row.status.includes("failed")) outcome = "partial";
    else outcome = "ok";
  }

  return { running, stale, startedAt: row.started_at, outcome, detail: row.status };
}
