"use client";

import { RefreshCw } from "lucide-react";
import { SlowJobHint } from "@/components/jobs/SlowJobHint";
import { type JobStartResult } from "@/lib/jobStatus";
import { formatStaleness } from "@/lib/format";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/** Same useJob/JobButton pattern as SyncWalletButtons.tsx — a connected
 * exchange's own independent job (exchange_sync_status/started_at), shown
 * instead of (not alongside) SyncWalletButtons for a provider-set wallet,
 * since there's no on-chain address to scan. */
export function SyncExchangeButton({
  exchangeSyncStatus,
  exchangeSyncStartedAt,
  exchangeSyncedAt,
  sync,
}: {
  exchangeSyncStatus: string | null;
  exchangeSyncStartedAt: string | null;
  exchangeSyncedAt: string | null;
  sync: () => Promise<JobStartResult>;
}) {
  const status = useJobStatus({ status: exchangeSyncStatus, started_at: exchangeSyncStartedAt });
  const { busy, submit, error } = useJob({ status, start: sync });

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
        Sync
      </JobButton>
      <SlowJobHint busy={busy} startedAt={status.running ? status.startedAt : null} />
      {!busy && (
        <p className={`max-w-xs text-right text-xs ${status.outcome === "error" ? "text-negative" : "text-fg-muted"}`}>
          {status.outcome === "error"
            ? `Sync failed: ${status.detail?.slice("error: ".length)}`
            : `Synced: ${formatStaleness(exchangeSyncedAt)}`}
        </p>
      )}
      {error && <p className="max-w-xs text-right text-xs text-negative">{error}</p>}
    </div>
  );
}
