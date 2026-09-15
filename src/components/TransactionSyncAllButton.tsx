"use client";

import { RefreshCw } from "lucide-react";
import { deriveJobStatus, type JobStartResult } from "@/lib/jobStatus";
import { useJob } from "./jobs/useJob";
import { useNow } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/**
 * "Sync all" on the Transactions page's "All wallets" view — same
 * aggregate-job shape as SyncAllWalletsButton.tsx (wallet-holdings sync),
 * reading tx_sync_status/tx_sync_started_at instead: `running` while any
 * wallet's own transaction sync is in flight, done once every claim it
 * kicked off has resolved.
 */
export function TransactionSyncAllButton({
  wallets,
  syncAll,
}: {
  wallets: { tx_sync_status: string | null; tx_sync_started_at: string | null }[];
  syncAll: () => Promise<JobStartResult>;
}) {
  const walletsKey = wallets.map((w) => `${w.tx_sync_status ?? ""}:${w.tx_sync_started_at ?? ""}`).join(",");
  const now = useNow([walletsKey]) ?? 0;
  let running = false;
  let latestStartedAt: string | null = null;
  for (const w of wallets) {
    const s = deriveJobStatus({ status: w.tx_sync_status, started_at: w.tx_sync_started_at }, now);
    if (s.running) running = true;
    if (w.tx_sync_started_at && (!latestStartedAt || w.tx_sync_started_at > latestStartedAt)) {
      latestStartedAt = w.tx_sync_started_at;
    }
  }

  const { busy, submit, error } = useJob({
    status: { running, stale: false, startedAt: latestStartedAt, outcome: null, detail: null },
    start: syncAll,
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <JobButton
        busy={busy}
        submit={submit}
        busyLabel={
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            Syncing…
          </>
        }
        variant="secondary"
        size="sm"
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Sync all
      </JobButton>
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}
