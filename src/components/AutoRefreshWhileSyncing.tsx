"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_POLL_MS = 4000;

/**
 * Renders nothing — just polls for a fresh server render while a
 * background sync (see wallets/actions.ts's syncWalletHoldings, which
 * returns almost immediately and does the real work in next/server's
 * after()) might still be in flight, so a "Syncing…" wallet detail page
 * picks up the real result on its own instead of showing a stale status
 * indefinitely until the user manually reloads.
 *
 * `pollMs` defaults to 4000 (wallet sync's own granularity, unchanged) —
 * pass a smaller value for something with faster-moving sub-states worth
 * actually seeing, like refreshPrices' three concurrent lanes
 * (PriceRefreshCaption), where the fastest lane can finish in a few
 * seconds — a 4s poll only gets one or two chances to ever catch it
 * mid-flight.
 */
export function AutoRefreshWhileSyncing({ syncing, pollMs = DEFAULT_POLL_MS }: { syncing: boolean; pollMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!syncing) return;
    const interval = setInterval(() => router.refresh(), pollMs);
    return () => clearInterval(interval);
  }, [syncing, pollMs, router]);

  return null;
}
