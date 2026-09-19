"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { readRecentWallets } from "@/lib/recentWallets";

const NAMESPACE = "trendFinderSearches";

/**
 * "Switch tabs, come back" should land back on the last token you were
 * actually looking at, not a blank picker — the Recent chips
 * (TrendRecentSearches) are for going back further than that one, not for
 * replacing this. Mounted only on the bare, param-less landing state;
 * on mount, redirects (router.replace — no extra history entry for the
 * empty state that flashed briefly) to the most recent search if one
 * exists, leaving the real empty state (the picker) for a genuinely first
 * visit with no history yet.
 *
 * Same "first paint uses the default, then snaps to the real client-side
 * preference" tradeoff usePersistedState.ts already documents and accepts
 * — this can only run after hydration (localStorage isn't available
 * during server rendering), so a first-visit flash of the empty picker is
 * expected, not a bug. Usually brief in practice: the target URL was, by
 * definition, visited recently, so it's likely still warm in the client
 * Router Cache (next.config.ts's 30-minute staleTimes.dynamic window)
 * rather than needing a fresh server round-trip.
 */
export function TrendLastSearchRedirect() {
  const router = useRouter();

  useEffect(() => {
    const recent = readRecentWallets(NAMESPACE);
    if (recent.length > 0) router.replace(`/trend-finder?id=${encodeURIComponent(recent[0].id)}`);
  }, [router]);

  return null;
}
