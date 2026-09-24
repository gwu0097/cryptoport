"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { formatSpan } from "@/lib/smc/time";
import { useNowSec, clientAnchorMs } from "./SignalTime";

// Wait this long after a bar/block closes before re-fetching, so Hyperliquid
// has published that candle's final close (the engines treat a candle as
// complete by wall-clock time alone).
const CLOSE_GRACE_MS = 10_000;
// A render already shown more than this long ago, mounting again, came from
// the client Router Cache (next.config.ts staleTimes.dynamic = 1800s reuses a
// page on in-app navigation, e.g. a timeframe pill back to one already
// visited) — refresh it.
const MAX_REUSE_AGE_MS = 60_000;

// Renders (by server computedAt) that already auto-refreshed: at most once
// each, whatever happens. Every comparison below is browser-elapsed time
// since the render was first shown here (clientAnchorMs), never server-vs-
// browser clock, so a skewed client clock can't make every fresh render look
// stale (a refresh loop hammering Hyperliquid).
const autoRefreshed = new Set<number>();

export function RefreshControl({
  computedAtSec,
  decidedAtSec,
  autoRefresh,
}: {
  computedAtSec: number;
  decidedAtSec: number | null;
  autoRefresh: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const now = useNowSec(computedAtSec);
  const refresh = () => startTransition(() => router.refresh());

  useEffect(() => {
    if (!autoRefresh) return;
    const before = Date.now();
    const firstSeen = clientAnchorMs(computedAtSec);
    const seenBefore = firstSeen < before; // an earlier mount already showed this render
    // decidedAt in the browser's clock: offset from computedAt as the server
    // stamped it, anchored when this browser first saw the render (latency only
    // makes it a few seconds late — safe).
    const closeMs = decidedAtSec === null ? null : firstSeen + (decidedAtSec - computedAtSec) * 1000 + CLOSE_GRACE_MS;
    const autoRefresh1 = () => {
      if (autoRefreshed.has(computedAtSec)) return;
      autoRefreshed.add(computedAtSec);
      startTransition(() => router.refresh());
    };
    const isStale = () => (seenBefore && Date.now() - firstSeen > MAX_REUSE_AGE_MS) || (closeMs !== null && Date.now() >= closeMs);
    if (isStale()) {
      autoRefresh1();
      return;
    }
    // Timers are throttled/paused in a background tab, so also re-check when
    // the tab becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === "visible" && closeMs !== null && Date.now() >= closeMs) autoRefresh1();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = closeMs !== null ? setTimeout(autoRefresh1, closeMs - Date.now()) : undefined;
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [autoRefresh, computedAtSec, decidedAtSec, router]);

  return (
    <span className="inline-flex items-center gap-2 text-xs text-fg-muted">
      {pending ? "Refreshing from Hyperliquid…" : `Updated ${now - computedAtSec < 60 ? "<1m" : formatSpan(now - computedAtSec)} ago`}
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-fg hover:border-accent disabled:opacity-50"
        title={autoRefresh ? "Also refreshes automatically when the forming bar closes" : undefined}
      >
        <RefreshCw className={`size-3 ${pending ? "animate-spin" : ""}`} aria-hidden="true" />
        Refresh
      </button>
    </span>
  );
}
