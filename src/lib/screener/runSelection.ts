// Pure: which live run represents a UTC day — see runSelection.test.ts and
// SPEC, "One run per UTC day". A day can hold more than one live run (Vercel
// cron delivery is best-effort and occasionally duplicates; manual runs add
// more). Decided 2026-09-23: the day's run is its LATEST live run with
// status "ok" (fresher data wins), preferring a complete run over a
// DEGRADED one (CoinGecko unavailable: market cap/supply/volume null) — a
// degraded run represents its day only when no complete ok run exists that
// day. Running/error/partial and backfill runs never represent a day. The
// 3b page and Phase 4's backtest both use this — the rule lives here once,
// not re-derived per query. Phase 4 then EXCLUDES days whose run is degraded.

export interface RunRow {
  id: string;
  started_at: string;
  status: string;
  kind: string;
  /** screener_runs.degraded; absent = false (rows from before the column). */
  degraded?: boolean;
}

/** Does `a` beat `b` as its day's run? Complete beats degraded; then later wins. */
function better(a: RunRow, b: RunRow): boolean {
  if (!!a.degraded !== !!b.degraded) return !a.degraded;
  return new Date(a.started_at).getTime() > new Date(b.started_at).getTime();
}

/** UTC date (YYYY-MM-DD) -> that day's representative run. */
export function pickRunPerUtcDay<R extends RunRow>(runs: readonly R[]): Map<string, R> {
  const byDay = new Map<string, R>();
  for (const r of runs) {
    if (r.kind !== "live" || r.status !== "ok") continue;
    const day = new Date(r.started_at).toISOString().slice(0, 10);
    const current = byDay.get(day);
    if (!current || better(r, current)) byDay.set(day, r);
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

/** UTC dates in the `days - 1` days before `now` (today excluded) that have
 * no ok live run. What counts as covering a day is the run's status, not
 * its completeness: a DEGRADED run (status ok) covers its day — the day was
 * captured, just thinly — so it never reads as a gap. Used by the snapshot
 * job's gap detector. */
export function findGapDates(runs: readonly RunRow[], now: Date, days: number): string[] {
  const covered = new Set(
    runs.filter((r) => r.kind === "live" && r.status === "ok").map((r) => new Date(r.started_at).toISOString().slice(0, 10)),
  );
  const gaps: string[] = [];
  for (let i = 1; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    if (!covered.has(date)) gaps.push(date);
  }
  return gaps;
}
