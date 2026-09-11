"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";

/**
 * Fires a wallet's own sync action once on mount — used only for the
 * ?autosync=1 landing after wallet sign-in/link auto-adds a brand-new
 * tracked wallet (see (auth)/walletActions.ts), so its balances show up
 * without the user having to find and click "Sync holdings" themselves on
 * a wallet they didn't manually create. useRef instead of a dependency
 * array guard: React 19's Strict Mode double-invokes effects in dev, which
 * would otherwise fire two syncs for one page load. Strips the query param
 * via router.replace once fired, so reloading this page later doesn't
 * re-trigger a sync every time.
 */
export function AutoSyncOnMount({ enabled, sync }: { enabled: boolean; sync: () => Promise<void> }) {
  const firedRef = useRef(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!enabled || firedRef.current) return;
    firedRef.current = true;
    // Awaited in order, not two fire-and-forget calls — sync() (a Server
    // Action) calls revalidatePath internally, which can itself trigger a
    // router refresh; running replace() before that settles risks the
    // ?autosync=1 param reappearing from a stale RSC payload.
    (async () => {
      try {
        await sync();
      } finally {
        router.replace(pathname);
      }
    })();
  }, [enabled, sync, router, pathname]);

  return null;
}
