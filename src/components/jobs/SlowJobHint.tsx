"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

const SLOW_AFTER_MS = 5_000;

/**
 * Shown under a sync button while its job runs: a live "Syncing for 6s"
 * counter from the moment it started, the last run's duration when known,
 * and — once past 5 s (asked for directly: "if a sync takes longer than 5
 * seconds, show a message ... that this may take a while") — that it keeps
 * running if you leave. The count starts at the server's own start time
 * (`startedAt`) when the poll has seen it, else when this page saw the job
 * start (the click). It used to appear only after 5 s, with just the last
 * run's time, which read as a timer that missed its first seconds.
 */
export function SlowJobHint({ busy, lastDurationMs, startedAt }: { busy: boolean; lastDurationMs?: number | null; startedAt?: string | null }) {
  // Mounted only while busy, so each run starts its own clock and the hint
  // disappears (and resets) the moment the job finishes.
  return busy ? <Elapsed lastDurationMs={lastDurationMs ?? null} startedAt={startedAt ?? null} /> : null;
}

function Elapsed({ lastDurationMs, startedAt }: { lastDurationMs: number | null; startedAt: string | null }) {
  // Clock readings only in effects (never during render), so the server
  // render and the first client render match.
  const [mountedAt, setMountedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const t0 = Date.now();
    setMountedAt(t0);
    setNow(t0);
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  if (mountedAt === null || now === null) return null;
  const serverStart = startedAt ? Date.parse(startedAt) : NaN;
  const start = Number.isFinite(serverStart) ? Math.min(serverStart, mountedAt) : mountedAt;
  const elapsed = Math.max(0, now - start);
  return (
    <p className="max-w-xs text-right text-xs text-fg-muted" role="status">
      Syncing for {formatDuration(elapsed)}
      {lastDurationMs !== null && ` · the last sync took ${formatDuration(lastDurationMs)}`}
      {elapsed >= SLOW_AFTER_MS && ". It keeps running if you leave this page."}
    </p>
  );
}
