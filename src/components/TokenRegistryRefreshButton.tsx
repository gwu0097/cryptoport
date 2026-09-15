"use client";

import { Database } from "lucide-react";
import { formatStaleness } from "@/lib/format";
import type { TokenRegistryState } from "@/lib/queries";
import { type JobStartResult } from "@/lib/jobStatus";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

/**
 * "Refresh token list" on the Wallets page — same useJob/JobButton
 * pattern as every other sync/refresh button in the app now
 * (PriceRefreshButton, SyncWalletButtons, ...), converting the last
 * remaining CLAUDE.md-documented offender: this action used to be awaited
 * directly with zero status tracking at all (no lock, no caption, no
 * live progress). See refreshTokenRegistryAction's own doc comment for
 * the CAS-claim details.
 */
export function TokenRegistryRefreshButton({
  tokenRegistryState,
  refresh,
}: {
  tokenRegistryState: TokenRegistryState;
  refresh: () => Promise<JobStartResult>;
}) {
  const status = useJobStatus({ status: tokenRegistryState.status, started_at: tokenRegistryState.startedAt });
  const { busy, submit, error } = useJob({ status, start: refresh });

  return (
    <div className="flex flex-col items-center gap-1">
      <JobButton
        busy={busy}
        submit={submit}
        busyLabel={
          <>
            <Database className="size-3.5 animate-pulse" aria-hidden="true" />
            Refreshing…
          </>
        }
        variant="secondary"
        size="sm"
      >
        <Database className="size-3.5" aria-hidden="true" />
        Refresh token list
      </JobButton>
      <p className="text-xs text-fg-muted">
        {busy ? "Refreshing…" : `Last refreshed: ${formatStaleness(tokenRegistryState.refreshedAt)}`}
      </p>
      {error && <p className="max-w-xs text-right text-xs text-negative">{error}</p>}
    </div>
  );
}
