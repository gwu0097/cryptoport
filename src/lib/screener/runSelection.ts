// Pure: which live run represents a UTC day — see runSelection.test.ts and
// SPEC, "One run per UTC day". A day can hold more than one live run (Vercel
// cron delivery is best-effort and occasionally duplicates; manual runs add
// more). Decided 2026-09-23: the day's run is its LATEST live run with
// status "ok" (fresher data wins). Running/error/partial and backfill runs
// never represent a day. The 3b page and Phase 4's backtest both use this —
// the rule lives here once, not re-derived per query.

export interface RunRow {
  id: string;
  started_at: string;
  status: string;
  kind: string;
}

/** UTC date (YYYY-MM-DD) -> that day's representative run. */
export function pickRunPerUtcDay<R extends RunRow>(runs: readonly R[]): Map<string, R> {
  const byDay = new Map<string, R>();
  for (const r of runs) {
    if (r.kind !== "live" || r.status !== "ok") continue;
    const day = new Date(r.started_at).toISOString().slice(0, 10);
    const current = byDay.get(day);
    if (!current || new Date(r.started_at).getTime() > new Date(current.started_at).getTime()) byDay.set(day, r);
  }
  return byDay;
}

/** The most recent day's representative run (what "latest" means on the
 * screener page), or null when no live run has ever finished ok. */
export function latestDailyRun<R extends RunRow>(runs: readonly R[]): R | null {
  let latest: R | null = null;
  for (const r of pickRunPerUtcDay(runs).values()) {
    if (!latest || new Date(r.started_at).getTime() > new Date(latest.started_at).getTime()) latest = r;
  }
  return latest;
}
