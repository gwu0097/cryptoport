"use client";

import { useEffect, useState } from "react";

// A render-time clock for relative times ("3m ago", "in 12m") that stays
// right when the client Router Cache re-shows an old render
// (next.config.ts staleTimes.dynamic = 1800): "now" is the SERVER's render
// time plus time elapsed in this browser since the render was first shown —
// never the browser's absolute clock, so a skewed client clock can't shift
// it either. A relative time computed on the server is frozen at render
// time instead (a reused view can claim "5m ago" when it's 35m).
// When THIS browser first saw each server render (keyed by the server's own
// clock reading for it). "Now" is then the server's time plus time elapsed on
// the browser's clock — never the browser's absolute clock — so a skewed
// client clock can't shift "(x ago)", the countdowns, or the stale flag.
const anchors = new Map<number, number>();

/** Browser-clock ms when the render stamped `serverNowSec` was first shown here. */
export function clientAnchorMs(serverNowSec: number): number {
  let a = anchors.get(serverNowSec);
  if (a === undefined) {
    a = Date.now();
    anchors.set(serverNowSec, a);
  }
  return a;
}

/** Current time in seconds, ticking every 30s. Starts at the SERVER's render
 * time (`serverNowSec`, passed down as a prop), so "(x ago)", the year and
 * the stale flag are in the server HTML and the first client render matches
 * it exactly (no hydration mismatch); then advances by browser-elapsed time. */
export function useNowSec(serverNowSec: number): number {
  const [now, setNow] = useState(serverNowSec);
  useEffect(() => {
    const anchor = clientAnchorMs(serverNowSec);
    const tick = () => setNow(serverNowSec + Math.floor((Date.now() - anchor) / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [serverNowSec]);
  return now;
}

