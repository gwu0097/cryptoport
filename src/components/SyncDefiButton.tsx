"use client";

import { RefreshCw } from "lucide-react";
import { type JobStartResult } from "@/lib/jobStatus";
import { formatStaleness } from "@/lib/format";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/**
 * "Sync DeFi" for an EVM wallet — same useJob/JobButton pattern as
 * TransactionSyncButton.tsx (a second, genuinely independent job on the
 * same wallet row, its own defi_sync_status/defi_sync_started_at pair, see
 * syncWalletDefi's own doc comment for why this is never folded into the
 * regular "Sync holdings" click or "Sync all wallets"). Deliberately its
 * own explicit button, not automatic — Zerion's free tier is a real,
 * shared budget, and this is the affordance that keeps spending it under
 * the user's own control.
 */
export function SyncDefiButton({
  defiSyncStatus,
  defiSyncStartedAt,
  defiSyncedAt,
  sync,
}: {
  defiSyncStatus: string | null;
  defiSyncStartedAt: string | null;
  defiSyncedAt: string | null;
  sync: () => Promise<JobStartResult>;
}) {
  const status = useJobStatus({ status: defiSyncStatus, started_at: defiSyncStartedAt });
  const { busy, submit, error } = useJob({ status, start: sync });

  return (
    <div className="flex flex-col items-end gap-1">
      <JobButton
        busy={busy}
        submit={submit}
        busyLabel={
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            Syncing DeFi…
          </>
        }
        variant="secondary"
        size="sm"
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Sync DeFi
      </JobButton>
      {!busy && (
        <p className={`max-w-xs text-right text-xs ${status.outcome === "error" ? "text-negative" : "text-fg-muted"}`}>
          {status.outcome === "error"
            ? `DeFi sync failed: ${status.detail?.slice("error: ".length)}`
            : `DeFi last synced: ${formatStaleness(defiSyncedAt)}`}
        </p>
      )}
      {error && <p className="max-w-xs text-right text-xs text-negative">{error}</p>}
    </div>
  );
}
