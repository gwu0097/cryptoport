"use client";

import Link from "next/link";
import { ArrowUp, ArrowDown, ChevronsUpDown, ExternalLink, RefreshCw, Trash } from "lucide-react";
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
import { useWalletsFilter } from "./wallets/WalletsFilterProvider";
import { filterWalletsByTags } from "@/lib/walletTagFilter";
import { deleteWallet, syncWalletHoldings, updateWallet } from "@/app/(app)/wallets/actions";

/** The per-row sync icon-button — its own component (not inlined in the
 * map below) because it needs its own useJob() call, one per wallet. */
function WalletSyncButton({ walletId, walletName, status }: { walletId: string; walletName: string; status: ReturnType<typeof deriveJobStatus> }) {
  const { busy, submit } = useJob({
    status,
    start: (): Promise<JobStartResult> => syncWalletHoldings(walletId, false),
  });
  return (
    <JobButton
      busy={busy}
      submit={submit}
      busyLabel={<RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />}
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
        <div className="flex items-center gap-1.5">
          <Link href={`/wallets/${wallet.id}`} className="text-fg hover:text-accent">
            {wallet.name}
          </Link>
          {wallet.externalViewer && (
            <a
              href={wallet.externalViewer.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`View on ${wallet.externalViewer.label}`}
              aria-label={`View ${wallet.name} on ${wallet.externalViewer.label}`}
              className="text-fg-muted transition hover:text-fg"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          )}
        </div>
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
        {wallet.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {wallet.tags.map((t) => (
              <span key={t.id} className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                {t.name}
              </span>
            ))}
          </div>
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
          {wallet.mode !== "auto" || wallet.provider ? (
            // A connected exchange has its own separate sync job (see
            // SyncCoinbaseButton on the wallet detail page) — this row's
            // button is wired to the regular on-chain sync only, which
            // would just fail cleanly ("no address set") for one of these,
            // so it's hidden the same way a manual wallet's is.
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

type SortKey = "name" | "chain" | "mode" | "value" | "refreshed" | "duration";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const SORT_KEYS: readonly SortKey[] = ["name", "chain", "mode", "value", "refreshed", "duration"];
const STORAGE_KEY = "cryptoport:walletsSort";
const DEFAULT_SORT: Sort = { key: "value", dir: "desc" };

// Guards against a sort persisted from before the Tag column stopped being
// sortable (see the Tag column's own history — it's now a filter, not a
// sort key) — a stored `{key:"tag"}` from an earlier session would
// otherwise fall through sortValue's switch below with no matching case.
function isValidSort(value: unknown): value is Sort {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    "dir" in value &&
    SORT_KEYS.includes((value as Sort).key) &&
    ((value as Sort).dir === "asc" || (value as Sort).dir === "desc")
  );
}

function sortValue(wallet: WalletWithTotal, key: SortKey): number | string {
  switch (key) {
    case "name":
      return wallet.name.toLowerCase();
    case "chain":
      return wallet.chain;
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
  const [rawSort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = isValidSort(rawSort) ? rawSort : DEFAULT_SORT;
  // Shared with SyncAllWalletsButton (see WalletsFilterProvider's own doc
  // comment) — "Sync all" only syncs whatever's currently filtered here.
  const { tagFilter, setTagFilter } = useWalletsFilter();

  function toggleSort(key: SortKey) {
    const dir = key === sortKey ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    setSort({ key, dir });
  }

  function toggleTagFilter(name: string) {
    setTagFilter(tagFilter.includes(name) ? tagFilter.filter((t) => t !== name) : [...tagFilter, name]);
  }

  const filtered = filterWalletsByTags(wallets, tagFilter);

  const sorted = [...filtered].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    const primary = sortDir === "desc" ? -cmp : cmp;
    if (primary !== 0) return primary;
    // Tie-break: always alphabetical by name, regardless of the primary
    // column's own direction — e.g. sorting by Chain descending groups
    // same-chain wallets together but shouldn't also reverse-alphabetize
    // them within that group.
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return (
    <>
      {/* Filter, not sort — a wallet's tags span independent dimensions
          (ownership: personal/business; storage: hard/soft wallet), which a
          single "sort by tag" column couldn't express at all. AND semantics:
          selecting more tags narrows the result (see the `filtered` calc
          above). */}
      {tagNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <span className="text-xs text-fg-muted">Filter by tag:</span>
          {tagNames.map((name) => {
            const active = tagFilter.includes(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleTagFilter(name)}
                aria-pressed={active}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  active
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-border bg-surface-raised text-fg-muted hover:text-fg"
                }`}
              >
                {name}
              </button>
            );
          })}
          {tagFilter.length > 0 && (
            <button
              type="button"
              onClick={() => setTagFilter([])}
              className="text-xs text-fg-muted underline hover:text-fg"
            >
              Clear
            </button>
          )}
          {tagFilter.length > 0 && (
            <span className="w-full text-xs text-fg-muted">
              Showing {sorted.length} of {wallets.length} wallet{wallets.length === 1 ? "" : "s"} ·{" "}
              {formatUsd(filtered.reduce((sum, w) => sum + w.total, 0))}
            </span>
          )}
        </div>
      )}

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
          <th className={`${thClass} ${hideOnMobileClass}`}>Tag</th>
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
        {sorted.length === 0 ? (
          <tr>
            <td colSpan={8} className={`${tdClass} text-center text-fg-muted`}>
              No wallets match the selected tags.
            </td>
          </tr>
        ) : (
          sorted.map((wallet) => <WalletRow key={wallet.id} wallet={wallet} tagNames={tagNames} />)
        )}
      </tbody>
      </table>
      </div>
    </>
  );
}
