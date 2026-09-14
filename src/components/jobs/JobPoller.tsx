"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

interface JobPollerContextValue {
  register: (id: string, busy: boolean, pollMs: number) => void;
  unregister: (id: string) => void;
}

const JobPollerContext = createContext<JobPollerContextValue | null>(null);

/**
 * One shared polling loop per page (mounted once in (app)/layout.tsx),
 * not one setInterval per busy button — real problem this avoids: "Sync
 * all wallets" can leave a dozen job buttons busy at once, and a dozen
 * independent timers would each call router.refresh() on their own
 * schedule, firing many more refreshes per second than any of them
 * individually asked for. Every useJob() call registers its own
 * busy/pollMs here; the provider runs a single interval at the fastest
 * pollMs any currently-busy job requested, and stops entirely once none
 * are busy.
 *
 * Also pauses while the tab is hidden (no point re-fetching a page
 * nobody's looking at) and refreshes once immediately when the tab
 * becomes visible/focused again, so a job that finished while this tab
 * was in the background is picked up right away instead of waiting for
 * the next scheduled tick.
 */
export function JobPollerProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const jobsRef = useRef(new Map<string, { busy: boolean; pollMs: number }>());
  const [minPollMs, setMinPollMs] = useState<number | null>(null);

  const recompute = useCallback(() => {
    let min: number | null = null;
    for (const { busy, pollMs } of jobsRef.current.values()) {
      if (busy) min = min === null ? pollMs : Math.min(min, pollMs);
    }
    setMinPollMs(min);
  }, []);

  const register = useCallback(
    (id: string, busy: boolean, pollMs: number) => {
      jobsRef.current.set(id, { busy, pollMs });
      recompute();
    },
    [recompute],
  );

  const unregister = useCallback(
    (id: string) => {
      jobsRef.current.delete(id);
      recompute();
    },
    [recompute],
  );

  useEffect(() => {
    if (minPollMs === null) return;

    const tick = () => {
      if (document.hidden) return;
      router.refresh();
    };
    const interval = setInterval(tick, minPollMs);

    const onVisible = () => {
      if (!document.hidden) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [minPollMs, router]);

  return <JobPollerContext.Provider value={{ register, unregister }}>{children}</JobPollerContext.Provider>;
}

let nextId = 0;

/** Registers one job's busy/pollMs with the page's JobPollerProvider for
 * as long as the calling component is mounted and `busy` is true. Silently
 * a no-op if no provider is mounted (defensive — every page under (app)/
 * has one via the root layout, but this shouldn't hard-crash a page that
 * somehow doesn't). */
export function useJobPolling(busy: boolean, pollMs: number): void {
  const ctx = useContext(JobPollerContext);
  const idRef = useRef<string>(undefined);
  if (idRef.current === undefined) idRef.current = `job-${nextId++}`;

  useEffect(() => {
    if (!ctx) return;
    const id = idRef.current!;
    ctx.register(id, busy, pollMs);
    return () => ctx.unregister(id);
  }, [ctx, busy, pollMs]);
}
