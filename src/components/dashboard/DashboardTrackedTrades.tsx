"use client";

import { TrackedPanel } from "@/components/perpScout/TrackedPanel";
import { useScoutMids } from "@/components/perpScout/useScoutMids";
import type { TrackedTrade } from "@/lib/perpScout/tracked";
import type { ScoutEntry } from "@/lib/perpScout/entries";
import type { ScoutClose } from "@/lib/perpScout/closes";
import type { ScoutBook } from "@/lib/perpScoutScan";

/** Perp Scout's tracked trades on the Dashboard, beside Open positions (owner
 * 2026-10-06). Read from Perp Scout's own store; the Dashboard's Refresh
 * prices updates their prices too (PRICES_REFRESHED_EVENT). */
export function DashboardTrackedTrades(props: {
  tracked: TrackedTrade[];
  entries: ScoutEntry[];
  closes: (ScoutClose & { iconUrl?: string | null })[];
  books: ScoutBook[];
  names: Record<string, string>;
  serverNowSec: number;
}) {
  const prices = useScoutMids(true);
  return <TrackedPanel {...props} prices={prices} signedIn compact storageKey="cryptoport:dashboardTrackedOpen" />;
}
