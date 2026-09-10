"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUp, ArrowDown, ChevronsUpDown, RefreshCw, Trash } from "lucide-react";
import type { WalletWithTotal } from "@/lib/queries";
import { formatStaleness, formatUsd, formatDuration } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "./ui/table";
import { buttonClass } from "./ui/Button";
import { SubmitButton } from "./ui/SubmitButton";
import { ConfirmDeleteButton } from "./ui/ConfirmDeleteButton";
import { EditWalletModal } from "./EditWalletModal";
import { AutoRefreshWhileSyncing } from "./AutoRefreshWhileSyncing";
import { deleteWallet, syncWalletHoldings, updateWallet } from "@/app/wallets/actions";

type SortKey = "name" | "chain" | "tag" | "mode" | "value" | "refreshed" | "duration";

const STORAGE_KEY = "cryptoport:walletsSort";
const DEFAULT_SORT: { key: SortKey; dir: "asc" | "desc" } = { key: "value", dir: "desc" };

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
}: {
  label: string;
  sortKeyValue: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  return (
    <th className={thClass}>
      <button type="button" onClick={() => onSort(sortKeyValue)} className="flex items-center gap-1 hover:text-fg">
        {label}
        <SortIcon active={sortKey === sortKeyValue} dir={sortDir} />
      </button>
    </th>
  );
}

export function WalletsTable({ wallets, tagNames }: { wallets: WalletWithTotal[]; tagNames: string[] }) {
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT.key);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(DEFAULT_SORT.dir);

  // Reads the remembered sort after mount (localStorage isn't available
  // during server rendering) — first paint uses the default (highest value
  // first), then snaps to whatever the user last chose, same trade-off
  // React's own docs describe for this exact "can't know yet" case. Not the
  // "derive state that could just be computed during render" anti-pattern
  // react-hooks/set-state-in-effect targets — this is synchronizing with an
  // external system (localStorage), which is what effects are for; disabled
  // narrowly rather than restructuring around a lint rule that doesn't fit.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (parsed?.key) setSortKey(parsed.key);
      if (parsed?.dir) setSortDir(parsed.dir);
    } catch {
      // corrupt/blocked storage — just keep the default
    }
  }, []);

  const isSyncing = wallets.some((w) => w.last_refresh_status === "syncing");

  function toggleSort(key: SortKey) {
    const dir = key === sortKey ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    setSortKey(key);
    setSortDir(dir);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, dir }));
    } catch {
      // best-effort — nothing to fall back to, the sort still applies this session
    }
  }

  const sorted = [...wallets].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <>
      <AutoRefreshWhileSyncing syncing={isSyncing} />
      <table className={tableClass}>
      <thead>
        <tr className={theadRowClass}>
          <Header label="Name" sortKeyValue="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Chain" sortKeyValue="chain" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Tag" sortKeyValue="tag" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Mode" sortKeyValue="mode" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Refreshed" sortKeyValue="refreshed" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Synced for" sortKeyValue="duration" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <th className={thClass}></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((wallet) => (
          <tr key={wallet.id} className={trClass}>
            <td className={tdClass}>
              <Link href={`/wallets/${wallet.id}`} className="text-fg hover:text-accent">
                {wallet.name}
              </Link>
            </td>
            <td className={tdClass}>
              <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                {wallet.chain}
              </span>
            </td>
            <td className={tdClass}>
              {wallet.tag ? (
                <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                  {wallet.tag.name}
                </span>
              ) : (
                <span className="text-fg-muted">—</span>
              )}
            </td>
            <td className={tdClass}>
              <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                {wallet.mode}
              </span>
            </td>
            <td className={`${tdClass} tabular-nums`}>{wallet.total > 0 ? formatUsd(wallet.total) : "—"}</td>
            <td className={`${tdClass} text-fg-muted`}>
              {wallet.last_refresh_status === "syncing" ? (
                <span className="text-fg">Syncing…</span>
              ) : (
                formatStaleness(wallet.last_refresh_at)
              )}
            </td>
            <td className={`${tdClass} tabular-nums text-fg-muted`}>
              {formatDuration(wallet.last_sync_duration_ms)}
            </td>
            <td className={tdClass}>
              <div className="flex items-center gap-2">
                <EditWalletModal
                  wallet={wallet}
                  tagNames={tagNames}
                  updateWallet={updateWallet.bind(null, wallet.id)}
                />
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
                ) : wallet.last_refresh_status === "syncing" ? (
                  <span
                    className={`${buttonClass("secondary", "sm")} cursor-not-allowed opacity-50`}
                    aria-label={`${wallet.name} is syncing`}
                  >
                    <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                  </span>
                ) : (
                  <form action={syncWalletHoldings.bind(null, wallet.id, false)}>
                    <SubmitButton variant="secondary" size="sm" aria-label={`Sync ${wallet.name}`}>
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                    </SubmitButton>
                  </form>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
      </table>
    </>
  );
}
