"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { inputClass } from "../ui/Field";
import type { WatchlistSummary } from "@/lib/queries";

// Same picker as the Dashboard's watchlist-movers filter
// (DashboardWatchlistFilter), with its own remembered choice — the two pages
// can sensibly watch different lists. "all" is an explicit, persisted value.
const STORAGE_KEY = "cryptoport:signalsWatchlist";

function readPref(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePref(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // best-effort: blocked storage just means it resets to "All" next visit
  }
}

export function SignalsWatchlistFilter({
  watchlists,
  selected,
  hasListParam,
  baseQuery,
}: {
  watchlists: WatchlistSummary[];
  selected: string | undefined;
  /** false on a visit with no ?list= — the saved choice is restored then. */
  hasListParam: boolean;
  /** coin + tf, kept when the list changes */
  baseQuery: string;
}) {
  const router = useRouter();
  const href = (value: string) => `/signals?${baseQuery}${value === "all" ? "" : `&list=${encodeURIComponent(value)}`}`;

  useEffect(() => {
    if (hasListParam) return;
    const pref = readPref();
    if (pref && pref !== "all" && watchlists.some((w) => w.id === pref)) router.replace(href(pref));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per bare visit
  }, [hasListParam]);

  return (
    <select
      value={selected ?? "all"}
      onChange={(e) => {
        writePref(e.target.value);
        router.push(href(e.target.value));
      }}
      className={`${inputClass} w-auto max-w-[14rem] px-2 py-1 text-xs font-semibold`}
      aria-label="Watchlist"
    >
      <option value="all">All watchlists</option>
      {watchlists.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name} ({w.itemCount})
        </option>
      ))}
    </select>
  );
}
