"use client";

import { RefreshCw } from "lucide-react";
import { deriveJobStatus, type JobStartResult } from "@/lib/jobStatus";
import { filterWallets } from "@/lib/walletTagFilter";
import { useJob } from "./jobs/useJob";
import { useNow } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";
import { useWalletsFilter } from "./wallets/WalletsFilterProvider";

interface SyncAllWallet {
  id: string;
  name: string;
  chain: string;
  address: string | null;
  notes: string | null;
  tags: { name: string }[];
  provider: string | null;
  last_refresh_status: string | null;
  sync_started_at: string | null;
  exchange_sync_status: string | null;
  exchange_sync_started_at: string | null;
}

/**
 * "Sync all wallets" — scoped to whatever the Wallets list's filter (tags +
 * search) is currently showing (see WalletsFilterProvider — the same filter state
 * WalletsTable's own rows use), not literally every wallet every time. A
 * real request from actual use: many long-term-holding wallets don't
 * change often enough to be worth re-syncing on every "Sync all" click, so
 * filtering to e.g. "Main" tagged wallets first and clicking this only
 * syncs those. No filter selected (the default) still syncs everything,
 * same as before — filterWalletsByTags([], ...) is an identity no-op.
 *
 * Its own aggregate job, not a per-wallet one: `running` is true while
 * *any* wallet **in the filtered set** is in flight, and the change-
 * detection `startedAt` is the most recent sync_started_at among *those*
 * — deliberately not tracking wallets outside the current filter, since
 * this button no longer touches them.
 */
export function SyncAllWalletsButton({
  wallets,
  syncAll,
}: {
  wallets: SyncAllWallet[];
  syncAll: (walletIds: string[]) => Promise<JobStartResult>;
}) {
  const { tagFilter, searchQuery } = useWalletsFilter();
  const filtered = filterWallets(wallets, { tags: tagFilter, query: searchQuery });
  const isFiltered = tagFilter.length > 0 || searchQuery.trim() !== "";

  // A connected exchange (provider set) reports its own sync via
  // exchange_sync_status/exchange_sync_started_at, not last_refresh_status/
  // sync_started_at — different columns entirely, matching the same split
  // syncAllWallets itself now dispatches on (syncExchangeHoldings vs
  // syncWalletHoldings). Reading the wrong pair for an exchange wallet
  // would leave this button reporting "not busy" while its exchange sync
  // is still genuinely running in the background.
  const walletsKey = filtered
    .map((w) => (w.provider ? `${w.exchange_sync_status ?? ""}:${w.exchange_sync_started_at ?? ""}` : `${w.last_refresh_status ?? ""}:${w.sync_started_at ?? ""}`))
    .join(",");
  const now = useNow([walletsKey]) ?? 0;
  let running = false;
  let latestStartedAt: string | null = null;
  for (const w of filtered) {
    const status = w.provider ? w.exchange_sync_status : w.last_refresh_status;
    const startedAt = w.provider ? w.exchange_sync_started_at : w.sync_started_at;
    const s = deriveJobStatus({ status, started_at: startedAt }, now);
    if (s.running) running = true;
    if (startedAt && (!latestStartedAt || startedAt > latestStartedAt)) {
      latestStartedAt = startedAt;
    }
  }

  const { busy, submit, error } = useJob({
    status: { running, stale: false, startedAt: latestStartedAt, outcome: null, detail: null },
    start: () => syncAll(filtered.map((w) => w.id)),
  });

  const label = isFiltered ? `Sync filtered (${filtered.length})` : "Sync all";

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
        {label}
      </JobButton>
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}
