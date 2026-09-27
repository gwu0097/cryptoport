"use client";

import { RefreshCw } from "lucide-react";
import { refreshInfluencers } from "@/app/(app)/wallet-watch/actions";
import { useJob } from "@/components/jobs/useJob";
import { JobButton } from "@/components/jobs/JobButton";
import type { JobStatus } from "@/lib/jobStatus";

/** Re-reads the addresses of one or more influencers in the background;
 * locked while any of them is being read (watchRefresh.ts). */
export function RefreshWatchButton({ influencerIds, status, label = "Refresh" }: { influencerIds: string[]; status: JobStatus; label?: string }) {
  const { busy, submit, error } = useJob({ status, start: () => refreshInfluencers(influencerIds) });
  if (influencerIds.length === 0) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <JobButton
        busy={busy}
        submit={submit}
        variant="secondary"
        size="sm"
        busyLabel={
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            Reading wallets…
          </>
        }
        title="Reads each address's balances again — the same reads as a wallet sync, without DeFi positions."
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        {label}
      </JobButton>
      {error && <span className="text-xs text-warning">{error}</span>}
    </span>
  );
}
