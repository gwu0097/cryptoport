"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isWatching, WATCH_FOR_MS } from "@/lib/liveWatching";

// The viewer's "Watching" switch (liveWatching.ts): when it ends, kept in
// this browser so it holds across the Dashboard, an influencer's page and a
// reload. Every panel on the page reads the same value. Storage can be
// blocked (private window): then it lasts for this page only.

const KEY = "cryptoport:watchActivityUntil";
const listeners = new Set<() => void>();
let memory: number | null = null;

function read(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return memory;
  }
}

function write(until: number | null): void {
  memory = until;
  try {
    if (until === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(until));
  } catch {
    // blocked storage: memory only
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener); // another tab changed it
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Whether the viewer is watching, when it ends, and the switch. Re-renders
 * when it ends by itself. */
export function useWatching(): { watching: boolean; until: number | null; nowMs: number; start: () => void; stop: () => void } {
  const until = useSyncExternalStore(subscribe, read, () => null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    // A tick every 30 s: the countdown, and the switch turning off on time.
    const tick = setInterval(() => setNowMs(Date.now()), 30_000);
    const end = setTimeout(() => setNowMs(Date.now()), Math.max(0, until - Date.now()));
    return () => {
      clearInterval(tick);
      clearTimeout(end);
    };
  }, [until]);
  return {
    watching: isWatching(until, nowMs),
    until,
    nowMs,
    start: () => {
      const now = Date.now();
      setNowMs(now);
      write(now + WATCH_FOR_MS);
    },
    stop: () => write(null),
  };
}
