"use client";

import { useEffect } from "react";
import { recordRecentWallet } from "@/lib/recentWallets";

/**
 * Invisible mount-effect component (same shape as AutoSyncOnMount) that
 * records this wallet as most-recently-viewed for the sidebar's "Recent
 * wallets" section — see lib/recentWallets.ts and
 * layout/RecentWalletsNav.tsx. Mounted once per wallet-detail-page visit
 * (wallets/[id]/page.tsx).
 */
export function RecordRecentWallet({ id, name }: { id: string; name: string }) {
  useEffect(() => {
    recordRecentWallet("wallets", { id, name });
  }, [id, name]);

  return null;
}
