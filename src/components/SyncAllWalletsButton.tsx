"use client";

import { RefreshCw } from "lucide-react";
import { deriveJobStatus, type JobStartResult } from "@/lib/jobStatus";
import { useJob } from "./jobs/useJob";
import { useNow } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/**
 * "Sync all wallets" — its own aggregate job, not a per-wallet one:
 * `running` is true while *any* active wallet's own sync is in flight,
 * and the change-detection `startedAt` is the most recent
 * sync_started_at among them. That's the right semantics for this
 * specific button (it's done once every individual sync it kicked off has
 * finished, whether or not a wallet was skipped because it was already
 * mid-sync from something else — the CAS claim inside syncWalletHoldings
 * decides that per wallet).
 */
export function SyncAllWalletsButton({
  wallets,
  syncAll,
}: {
  wallets: { last_refresh_status: string | null; sync_started_at: string | null }[];
  syncAll: () => Promise<JobStartResult>;
}) {
  const walletsKey = wallets.map((w) => `${w.last_refresh_status ?? ""}:${w.sync_started_at ?? ""}`).join(",");
  const now = useNow([walletsKey]) ?? 0;
  let running = false;
  let latestStartedAt: string | null = null;
  for (const w of wallets) {
    const s = deriveJobStatus({ status: w.last_refresh_status, started_at: w.sync_started_at }, now);
    if (s.running) running = true;
    if (w.sync_started_at && (!latestStartedAt || w.sync_started_at > latestStartedAt)) {
      latestStartedAt = w.sync_started_at;
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
