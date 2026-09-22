"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { readDashboardWatchlistPref } from "@/lib/dashboardWatchlistPref";

/**
 * Same "only mounted on the bare, param-less landing state, then snaps to
 * the last real choice on mount" shape as TrendLastSearchRedirect — see
 * that component's own doc comment for the first-paint-flash tradeoff
 * this accepts too (localStorage isn't available during server
 * rendering). "all" is a real, explicitly-persisted choice (see
 * dashboardWatchlistPref.ts) and needs no redirect — a bare /dashboard
 * already renders as "All watchlists" with no `?list=` param, so this
 * only ever redirects toward a specific saved watchlist id.
 */
export function DashboardWatchlistRedirect() {
  const router = useRouter();

  useEffect(() => {
    const pref = readDashboardWatchlistPref();
    if (pref && pref !== "all") router.replace(`/dashboard?list=${encodeURIComponent(pref)}`);
  }, [router]);

  return null;
}
