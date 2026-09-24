"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

const SLOW_AFTER_MS = 5_000;

/**
 * Shown under a sync button once a job has been running for more than 5s
 * (asked for directly: "if a sync takes longer than 5 seconds, show a
 * message ... that this may take a while"). Some syncs legitimately take
 * minutes — a Cosmos wallet scans ~160 chains, an EVM wallet ~30 — and a
 * spinner alone reads as stuck. Counted from when this page saw the job
 * start, in the browser. With the last run's duration when known.
 */
export function SlowJobHint({ busy, lastDurationMs }: { busy: boolean; lastDurationMs?: number | null }) {
  // Mounted only while busy, so each sync starts its own 5s clock and the
  // hint disappears (and resets) the moment the job finishes.
  return busy ? <SlowAfterDelay lastDurationMs={lastDurationMs ?? null} /> : null;
}

function SlowAfterDelay({ lastDurationMs }: { lastDurationMs: number | null }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return null;
  return (
    <p className="max-w-xs text-right text-xs text-fg-muted" role="status">
      Still syncing — this can take a while
      {lastDurationMs !== null && lastDurationMs > SLOW_AFTER_MS ? ` (the last sync took ${formatDuration(lastDurationMs)})` : ""}. It keeps
      running if you leave this page.
    </p>
  );
}
