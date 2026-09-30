"use client";

import { useState, useTransition } from "react";
import { setAutoSync } from "@/app/(app)/wallets/actions";
import { AUTO_SYNC_MAX } from "@/lib/autoSync";

/** The wallet's "Auto-sync daily" switch (autoSync.ts), with why you'd
 * want it. Syncing by hand works the same either way. */
export function AutoSyncToggle({ walletId, on }: { walletId: string; on: boolean }) {
  const [checked, setChecked] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="text-xs">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setChecked(next);
            setError(null);
            start(async () => {
              const err = await setAutoSync(walletId, next);
              if (err) {
                setChecked(!next);
                setError(err);
              }
            });
          }}
          className="size-4 accent-accent"
        />
        Auto-sync daily
      </label>
      <p className="mt-0.5 max-w-md text-fg-muted">
        For a wallet you trade from, so a coin you sold doesn&apos;t still show as held. Pressing Refresh prices also syncs it, at most once a day, in the background. Up to {AUTO_SYNC_MAX} wallets; Sync still works any time.
      </p>
      {error && <p className="mt-0.5 text-negative">{error}</p>}
    </div>
  );
}
