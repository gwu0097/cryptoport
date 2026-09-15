"use client";

import Link from "next/link";
import { ArrowUp, ArrowDown, ChevronsUpDown, RefreshCw, Trash } from "lucide-react";
import type { WalletWithTotal } from "@/lib/queries";
import { deriveJobStatus, type JobStartResult } from "@/lib/jobStatus";
import { formatStaleness, formatUsd, formatDuration } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "./ui/table";
import { buttonClass } from "./ui/Button";
import { ConfirmDeleteButton } from "./ui/ConfirmDeleteButton";
import { EditWalletModal } from "./EditWalletModal";
import { VerifyWalletModal } from "./VerifyWalletModal";
import { VerifiedBadge } from "./VerifiedBadge";
import { JobButton } from "./jobs/JobButton";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { usePersistedState } from "./usePersistedState";
import { deleteWallet, syncWalletHoldings, updateWallet } from "@/app/(app)/wallets/actions";

/** The per-row sync icon-button — its own component (not inlined in the
 * map below) because it needs its own useJob() call, one per wallet. */
function WalletSyncButton({ walletId, walletName, status }: { walletId: string; walletName: string; status: ReturnType<typeof deriveJobStatus> }) {
  const { busy, isPending, submit } = useJob({
    status,
    start: (): Promise<JobStartResult> => syncWalletHoldings(walletId, false),
  });
  return (
    <JobButton
      busy={busy}
      isPending={isPending}
      submit={submit}
      busyLabel={<RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />}
      pendingLabel={<RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />}
      variant="secondary"
      size="sm"
      aria-label={busy ? `${walletName} is syncing` : `Sync ${walletName}`}
    >
      <RefreshCw className="size-3.5" aria-hidden="true" />
    </JobButton>
  );
}

/** One table row — its own component (not inlined in the map above)
 * because useJobStatus is a hook: calling it once per row inside a plain
 * .map() callback would call it a variable number of times per render of
 * the parent, which the rules of hooks disallow. Giving each row its own
 * component instance makes that one call-per-row stable and legal. */
function WalletRow({ wallet, tagNames }: { wallet: WalletWithTotal; tagNames: string[] }) {
  const jobStatus = useJobStatus({ status: wallet.last_refresh_status, started_at: wallet.sync_started_at });

  return (
    <tr className={trClass}>
      <td className={tdClass}>
        <Link href={`/wallets/${wallet.id}`} className="text-fg hover:text-accent">
          {wallet.name}
        </Link>
      </td>
      <td className={tdClass}>
        <div className="flex items-center gap-1">
          <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{wallet.chain}</span>
          {wallet.pinnedChain && wallet.address ? (
            wallet.verified ? (
              <VerifiedBadge />
            ) : (
              <VerifyWalletModal pinnedTarget={{ chain: wallet.pinnedChain, address: wallet.address }} />
            )
          ) : (
            // Same-height placeholder trick as the actions column's own
            // invisible sync button below — without it, a chain with no
            // wallet-auth scheme (BTC, ADA, ...) rendered a shorter row
            // than one with the labeled Verify/Verified pill next to it.
            <span className={`${buttonClass("secondary", "sm")} invisible`} aria-hidden="true">
              Verify
            </span>
          )}
        </div>
      </td>
      <td className={`${tdClass} ${hideOnMobileClass}`}>
        {wallet.tag ? (
          <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{wallet.tag.name}</span>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </td>
      <td className={`${tdClass} ${hideOnMobileClass}`}>
        <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{wallet.mode}</span>
      </td>
      <td className={`${tdClass} tabular-nums`}>{wallet.total > 0 ? formatUsd(wallet.total) : "—"}</td>
      <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>
        {jobStatus.running ? <span className="text-fg">Syncing…</span> : formatStaleness(wallet.last_refresh_at)}
      </td>
      <td className={`${tdClass} ${hideOnMobileClass} tabular-nums text-fg-muted`}>
        {formatDuration(wallet.last_sync_duration_ms)}
      </td>
      <td className={tdClass}>
        <div className="flex items-center gap-2">
          <EditWalletModal wallet={wallet} tagNames={tagNames} updateWallet={updateWallet.bind(null, wallet.id)} />
          <form action={deleteWallet.bind(null, wallet.id)}>
            <ConfirmDeleteButton
              confirmMessage={`Delete "${wallet.name}"? This won't delete its holdings.`}
              aria-label={`Delete ${wallet.name}`}
            >
              <Trash className="size-3.5" aria-hidden="true" />
            </ConfirmDeleteButton>
          </form>
          {wallet.mode !== "auto" ? (
            <span className={`${buttonClass("secondary", "sm")} invisible`} aria-hidden="true">
              <RefreshCw className="size-3.5" aria-hidden="true" />
            </span>
          ) : (
            <WalletSyncButton walletId={wallet.id} walletName={wallet.name} status={jobStatus} />
          )}
        </div>
      </td>
    </tr>
  );
}

type SortKey = "name" | "chain" | "tag" | "mode" | "value" | "refreshed" | "duration";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:walletsSort";
const DEFAULT_SORT: Sort = { key: "value", dir: "desc" };

function sortValue(wallet: WalletWithTotal, key: SortKey): number | string {
  switch (key) {
    case "name":
      return wallet.name.toLowerCase();
    case "chain":
      return wallet.chain;
    case "tag":
      return wallet.tag?.name.toLowerCase() ?? "";
    case "mode":
      return wallet.mode;
    case "value":
      return wallet.total;
    case "refreshed":
      return wallet.last_refresh_at ?? "";
    case "duration":
      return wallet.last_sync_duration_ms ?? -1;
  }
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronsUpDown className="size-3 text-fg-muted/50" aria-hidden="true" />;
  return dir === "desc" ? (
    <ArrowDown className="size-3" aria-hidden="true" />
  ) : (
    <ArrowUp className="size-3" aria-hidden="true" />
  );
}

function Header({
  label,
  sortKeyValue,
  sortKey,
  sortDir,
  onSort,
  className = "",
}: {
  label: string;
  sortKeyValue: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <th className={`${thClass} ${className}`}>
      <button type="button" onClick={() => onSort(sortKeyValue)} className="flex items-center gap-1 hover:text-fg">
        {label}
        <SortIcon active={sortKey === sortKeyValue} dir={sortDir} />
      </button>
    </th>
  );
}

export function WalletsTable({ wallets, tagNames }: { wallets: WalletWithTotal[]; tagNames: string[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: SortKey) {
    const dir = key === sortKey ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    setSort({ key, dir });
  }

  const sorted = [...wallets].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <>
      {/* overflow-x-auto, not the Panel's own overflow-hidden — the Panel
          wrapping this table clips to keep its rounded corners, which on a
          narrow viewport with 8 columns silently clipped the right-hand
          columns with no way to reach them instead of letting just the
          table scroll horizontally. */}
      <div className="overflow-x-auto">
      <table className={tableClass}>
      <thead>
        <tr className={theadRowClass}>
          <Header label="Name" sortKeyValue="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Chain" sortKeyValue="chain" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header
            label="Tag"
            sortKeyValue="tag"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            className={hideOnMobileClass}
          />
          <Header
            label="Mode"
            sortKeyValue="mode"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            className={hideOnMobileClass}
          />
          <Header label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header
            label="Synced"
            sortKeyValue="refreshed"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            className={hideOnMobileClass}
          />
          <Header
            label="Synced for"
            sortKeyValue="duration"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            className={hideOnMobileClass}
          />
          <th className={thClass}></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((wallet) => (
          <WalletRow
            key={wallet.id}
            wallet={wallet}
            tagNames={tagNames}
          />
        ))}
      </tbody>
      </table>
      </div>
    </>
  );
}
