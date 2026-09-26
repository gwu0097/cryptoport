"use client";

import { RefreshCw } from "lucide-react";
import { SlowJobHint } from "@/components/jobs/SlowJobHint";
import { type JobStartResult } from "@/lib/jobStatus";
import { formatStaleness } from "@/lib/format";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/**
 * "Sync this wallet" on the Transactions page, for whichever wallet is
 * currently selected — same useJob/JobButton pattern as
 * SyncWalletButtons.tsx (wallet-holdings sync), but reading its own
 * tx_sync_status/tx_sync_started_at pair (a genuinely separate job from
 * holdings sync — see syncWalletTransactions' own doc comment) and its
 * own caption copy. Not merged into SyncWalletButtons: no "Full sync"
 * variant here, different field names, and a different caption format
 * ("Sync failed: ..." vs. holdings' plain error passthrough) — small
 * enough duplication that forcing one shared component would need more
 * prop-plumbing than it saves.
 */
export function TransactionSyncButton({
  txSyncStatus,
  txSyncStartedAt,
  txSyncedAt,
  sync,
}: {
  txSyncStatus: string | null;
  txSyncStartedAt: string | null;
  txSyncedAt: string | null;
  sync: () => Promise<JobStartResult>;
}) {
  const status = useJobStatus({ status: txSyncStatus, started_at: txSyncStartedAt });
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
        Sync this wallet
      </JobButton>
      <SlowJobHint busy={busy} startedAt={status.running ? status.startedAt : null} />
      {/* No "Syncing…" caption while busy — the button's own busyLabel
          already says that; reported directly as redundant. */}
      {!busy && (
        <p className={`max-w-xs text-right text-xs ${status.outcome === "error" ? "text-negative" : "text-fg-muted"}`}>
          {status.outcome === "error"
            ? `Sync failed: ${status.detail?.slice("error: ".length)}`
            : `Last synced: ${formatStaleness(txSyncedAt)}`}
        </p>
      )}
      {error && <p className="max-w-xs text-right text-xs text-negative">{error}</p>}
    </div>
  );
}
