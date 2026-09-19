"use client";

import { useEffect } from "react";
import { recordRecentWallet } from "@/lib/recentWallets";

/**
 * Invisible mount-effect component (same shape as AutoSyncOnMount) that
 * records this wallet as most-recently-viewed for the sidebar's "Recent"
 * section under whichever nav item's namespace it's mounted for — see
 * lib/recentWallets.ts and layout/RecentWalletsNav.tsx. `namespace`
 * defaults to "wallets" (wallets/[id]/page.tsx's own original call site,
 * from before any other page needed this) — Transactions passes
 * "transactionsWallets" so its own recent list stays genuinely separate,
 * same reasoning recentWallets.ts already gives for Analytics' namespace.
 *
 * `maxRecent` — omit for the original 4-item cap; Trend Finder's own
 * recent-searches namespace passes 5 (see recordRecentWallet's own doc
 * comment).
 */
export function RecordRecentWallet({
  id,
  name,
  namespace = "wallets",
  maxRecent,
}: {
  id: string;
  name: string;
  namespace?: string;
  maxRecent?: number;
}) {
  useEffect(() => {
    recordRecentWallet(namespace, { id, name }, maxRecent);
  }, [id, name, namespace, maxRecent]);

  return null;
}
