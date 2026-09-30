"use client";

import { useState, useTransition } from "react";
import { setAutoSync } from "@/app/(app)/wallets/actions";
import { AUTO_SYNC_MAX } from "@/lib/autoSync";
import { InfoTooltip } from "@/components/ui/InfoTooltip";

/** The wallet's "Auto-sync daily" switch (autoSync.ts); why you'd want it
 * is in the tooltip. Syncing by hand works the same either way. */
export function AutoSyncToggle({ walletId, on }: { walletId: string; on: boolean }) {
  const [checked, setChecked] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-fg">
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
          className="size-3.5 accent-accent"
        />
        Auto-sync daily
      </label>
      <InfoTooltip>
        For a wallet you trade from, so a coin you sold doesn&apos;t still show as held. Pressing Refresh prices also syncs it, at most once a day, in the background. Up to {AUTO_SYNC_MAX} wallets; Sync still works any time.
      </InfoTooltip>
      {error && <span className="text-negative">{error}</span>}
    </span>
  );
}
