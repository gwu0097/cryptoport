"use client";

import { useRouter } from "next/navigation";
import { inputClass } from "../ui/Field";
import { writeDashboardWatchlistPref } from "@/lib/dashboardWatchlistPref";
import type { WatchlistSummary } from "@/lib/queries";

/**
 * Same shape as TransactionsWalletFilter (a native `<select>` needs an
 * onChange handler to navigate — there's no way to make one itself a
 * link), plus the one thing that page's filter doesn't need: writing the
 * choice to localStorage so DashboardWatchlistRedirect can restore it on
 * a later bare `/dashboard` visit — reported directly, "keep the last
 * selected watchlist when clicking dashboard."
 */
export function DashboardWatchlistFilter({
  watchlists,
  selected,
}: {
  watchlists: WatchlistSummary[];
  selected: string | undefined;
}) {
  const router = useRouter();

  return (
    <select
      value={selected ?? "all"}
      onChange={(e) => {
        const value = e.target.value;
        writeDashboardWatchlistPref(value);
        router.push(value === "all" ? "/dashboard" : `/dashboard?list=${encodeURIComponent(value)}`);
      }}
      className={`${inputClass} w-auto max-w-[11rem] px-2 py-1 text-xs font-semibold`}
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
