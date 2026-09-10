"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 4000;

/**
 * Renders nothing — just polls for a fresh server render while a
 * background sync (see wallets/actions.ts's syncWalletHoldings, which
 * returns almost immediately and does the real work in next/server's
 * after()) might still be in flight, so a "Syncing…" wallet detail page
 * picks up the real result on its own instead of showing a stale status
 * indefinitely until the user manually reloads.
 */
export function AutoRefreshWhileSyncing({ syncing }: { syncing: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!syncing) return;
    const interval = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [syncing, router]);

  return null;
}
