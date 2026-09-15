"use client";

import { RefreshCw } from "lucide-react";
import { type JobStartResult } from "@/lib/jobStatus";
import { formatStaleness, formatDuration } from "@/lib/format";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/**
 * "Sync holdings" (+ "Full sync" for a BTC xpub wallet that's cached a
 * script type) on the wallet detail page — both share one underlying job
 * (the same wallets.last_refresh_status/sync_started_at row), so clicking
 * either locks both, matching the real constraint (only one sync can be
 * in flight for a wallet at a time; see syncWalletHoldings' own
 * compare-and-set claim). Replaces the old plain-SubmitButton +
 * hand-rolled "syncing -> disabled span" branch — that version unlocked
 * the instant the network round-trip finished even though the real sync
 * kept running in the background, which is the exact bug reported.
 */
export function SyncWalletButtons({
  lastRefreshStatus,
  syncStartedAt,
  lastRefreshAt,
  lastSyncDurationMs,
  sync,
  fullSync,
}: {
  lastRefreshStatus: string | null;
  syncStartedAt: string | null;
  lastRefreshAt: string | null;
  lastSyncDurationMs: number | null;
  sync: () => Promise<JobStartResult>;
  fullSync: (() => Promise<JobStartResult>) | null;
}) {
  const status = useJobStatus({ status: lastRefreshStatus, started_at: syncStartedAt });
  const job = useJob({ status, start: sync });
  const fullJob = useJob({ status, start: fullSync ?? sync });
  const busy = job.busy || fullJob.busy;
  const error = job.error ?? fullJob.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <JobButton
          busy={busy}
          isPending={job.isPending}
          submit={job.submit}
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
          Sync holdings
        </JobButton>
        {/* Only worth offering once a cache exists to override — without
            one, plain "Sync holdings" already does the full check. For
            e.g. a wallet that's switched address format and needs
            re-detecting. */}
        {fullSync && (
          <JobButton
            busy={busy}
            isPending={fullJob.isPending}
            submit={fullJob.submit}
            busyLabel="Syncing…"
            variant="secondary"
            size="sm"
            title="Re-check all address formats instead of using the cached one — use this if the wallet's address format changed."
          >
            Full sync
          </JobButton>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        {busy ? (
          "Syncing…"
        ) : status.outcome === "error" ? (
          <span className="text-negative">{status.detail}</span>
        ) : (
          <>
            Synced: {formatStaleness(lastRefreshAt)}
            {lastSyncDurationMs !== null && <> · took {formatDuration(lastSyncDurationMs)}</>}
          </>
        )}
      </p>
      {error && <p className="max-w-xs text-right text-xs text-negative">{error}</p>}
    </div>
  );
}
