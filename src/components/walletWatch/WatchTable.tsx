"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { isInProgressStatus } from "@/lib/jobStatus";
import { ExternalLink, Radio, Search, Trash2, X } from "lucide-react";
import { removeInfluencer, removeInfluencers, renameInfluencer, setInfluencerLive } from "@/app/(app)/wallet-watch/actions";
import { InlineName } from "@/components/ui/InlineName";
import { ConfirmActionButton } from "@/components/ui/ConfirmActionButton";
import { Button } from "@/components/ui/Button";
import { GroupChips } from "./GroupChips";
import type { WatchedInfluencer, WatchGroup } from "@/lib/watchQuery";
import { formatUsd } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";
import { AgeText } from "@/components/AgeText";

type SortKey = "name" | "value" | "refreshed";
type Sort = { key: SortKey; dir: "asc" | "desc" };

function sortValue(i: WatchedInfluencer, key: SortKey): number | string {
  switch (key) {
    case "name":
      return i.name.toLowerCase();
    case "value":
      return i.valueUsd ?? -Infinity;
    case "refreshed":
      return i.lastRefreshAt ? Date.parse(i.lastRefreshAt) : -Infinity;
  }
}

const FAMILY: Record<string, string> = { ETH: "EVM", SOL: "Solana", BTC: "Bitcoin" };

/** Does the influencer match the search: every word in its name, note,
 * addresses, chains, groups or top holdings (like the Wallets list's). */
function matches(i: WatchedInfluencer, groupName: Map<string, string>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [
    i.name,
    i.note ?? "",
    ...i.addresses.flatMap((a) => [a.address, a.chain, FAMILY[a.chain] ?? ""]),
    ...i.groupIds.map((g) => groupName.get(g) ?? ""),
    ...i.topHoldings.map((h) => h.ticker),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Owner only: live updates on or off from the list (the same switch as the
 * influencer page's LiveToggle). */
function LiveSwitch({ id, live }: { id: string; live: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={live}
      title={error ?? (live ? "Live updates on — click to turn off" : "Live updates off — click to turn on (Helius / Alchemy webhooks)")}
      onClick={() =>
        start(async () => {
          const r = await setInfluencerLive(id, !live);
          setError(r.ok ? null : r.error);
        })
      }
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition disabled:opacity-60 ${error ? "border-warning/50 text-warning" : live ? "border-positive/50 bg-positive/10 text-positive" : "border-border text-fg-muted hover:text-fg"}`}
    >
      <Radio className={`size-3 ${live && !pending ? "animate-pulse" : ""}`} aria-hidden="true" />
      {pending ? "…" : live ? "Live" : "Off"}
    </button>
  );
}

/** The watched influencers of the selected group, with what they hold now
 * (the last read's quantities at today's prices). Managed in place (owner
 * 2026-09-30, like the Wallets list): rename, groups, live, delete — one
 * row, or the ticked ones together. */
export function WatchTable({ influencers, groups, serverNowSec, isOwner = false }: { influencers: WatchedInfluencer[]; groups: WatchGroup[]; serverNowSec: number; isOwner?: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:walletWatchSort", { key: "value", dir: "desc" });
  const { key: sortKey, dir: sortDir } = sort;
  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  const rows = influencers.filter((i) => matches(i, groupName, query)).sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  const visible = new Set(rows.map((r) => r.id));
  const chosen = [...selected].filter((id) => visible.has(id));
  const allChosen = rows.length > 0 && chosen.length === rows.length;

  return (
    <div className="overflow-x-auto">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search by name, address, chain, group or coin"
            aria-label="Search watched wallets"
            className="w-full rounded-lg border border-border bg-surface-raised py-1.5 pl-8 pr-8 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        {query && (
          <span className="text-xs text-fg-muted">
            {rows.length} of {influencers.length}
          </span>
        )}
      </div>
      {chosen.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised/40 px-3 py-2 text-sm">
          <span className="text-fg">{chosen.length} selected</span>
          <ConfirmActionButton
            message={`Stop watching ${chosen.length} influencer${chosen.length === 1 ? "" : "s"}?`}
            confirmLabel="Stop watching"
            disabled={pending}
            onConfirm={() =>
              start(async () => {
                const r = await removeInfluencers(chosen);
                if (r.ok) setSelected(new Set());
                setError(r.ok ? null : r.error);
              })
            }
            trigger={(open) => (
              <Button type="button" variant="danger" size="sm" disabled={pending} onClick={open}>
                <Trash2 className="size-3.5" aria-hidden="true" /> Delete selected
              </Button>
            )}
          />
          <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          {error && <span className="text-xs text-negative">{error}</span>}
        </div>
      )}
      <table className={tableClass}>
        <thead>
          <tr className={theadRowClass}>
            <th className={`${thClass} w-8`}>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allChosen}
                onChange={() => setSelected(allChosen ? new Set() : new Set(rows.map((r) => r.id)))}
                className="size-3.5 accent-accent"
              />
            </th>
            <SortableHeader label="Influencer" sortKeyValue="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <th className={`${thClass} ${hideOnMobileClass}`}>Top holdings</th>
            <th className={`${thClass} ${hideOnMobileClass}`}>Groups</th>
            <SortableHeader label="Last read" sortKeyValue="refreshed" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
            {isOwner && <th className={thClass}>Live</th>}
            <th className={thClass}>
              <span className="sr-only">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={isOwner ? 8 : 7} className={`${tdClass} text-center text-sm text-fg-muted`}>
                No watched wallet matches “{query}”.
              </td>
            </tr>
          )}
          {rows.map((i) => {
            const reading = i.addresses.some((a) => isInProgressStatus(a.refreshStatus));
            const failed = i.addresses.filter((a) => a.lastRefreshStatus?.startsWith("error:")).length;
            return (
              <tr key={i.id} className={`${trClass} ${selected.has(i.id) ? "bg-accent/5" : ""}`}>
                <td className={tdClass}>
                  <input type="checkbox" aria-label={`Select ${i.name}`} checked={selected.has(i.id)} onChange={() => toggleOne(i.id)} className="size-3.5 accent-accent" />
                </td>
                <td className={tdClass}>
                  <span className="flex items-center gap-1.5">
                    <InlineName
                      name={i.name}
                      onSave={async (next) => {
                        const r = await renameInfluencer(i.id, next);
                        return r.ok ? null : r.error;
                      }}
                    >
                      <Link href={`/wallet-watch/${i.id}`} className="font-medium text-fg hover:underline">
                        {i.name}
                      </Link>
                    </InlineName>
                    {i.link && (
                      <a href={i.link} target="_blank" rel="noopener noreferrer" aria-label={`${i.name}'s profile`} className="text-fg-muted hover:text-fg">
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                  </span>
                  <div className="text-xs text-fg-muted">
                    {i.addresses.length} address{i.addresses.length === 1 ? "" : "es"} · {[...new Set(i.addresses.map((a) => FAMILY[a.chain] ?? a.chain))].join(", ")}
                  </div>
                </td>
                <td className={`${tdClass} tabular-nums`}>
                  {i.valueUsd === null ? (reading ? <span className="text-fg-muted">Reading…</span> : "—") : formatUsd(i.valueUsd)}
                  {i.unpricedCount > 0 && (
                    <div className="text-xs text-warning" title="Holdings with no price, or illiquid ones (worth more than their coin trades) — shown on the influencer's page, not counted in the value">
                      {i.unpricedCount} not counted
                    </div>
                  )}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>
                  {i.topHoldings.length === 0 ? (
                    <span className="text-fg-muted">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {i.topHoldings.map((h) => (
                        <span key={h.ticker} className="whitespace-nowrap">
                          <span className="font-medium text-fg">{h.ticker}</span> <span className="text-fg-muted">{formatUsd(h.usd)}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} [&>span]:mt-0`}>
                  {/* Click a group to add or remove it (GroupChips). */}
                  <GroupChips influencerId={i.id} groupIds={i.groupIds} groups={groups} />
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} text-xs text-fg-muted`}>
                  {reading ? "Reading now…" : <AgeText at={i.lastRefreshAt} serverNowSec={serverNowSec} />}
                  {failed > 0 && <div className="text-warning">{failed} address{failed === 1 ? "" : "es"} failed</div>}
                </td>
                {isOwner && <td className={tdClass}>{i.live === null ? <span className="text-xs text-fg-muted">—</span> : <LiveSwitch id={i.id} live={i.live} />}</td>}
                <td className={`${tdClass} text-right`}>
                  <ConfirmActionButton
                    message={`Stop watching ${i.name}?`}
                    confirmLabel="Stop watching"
                    onConfirm={() => start(async () => void (await removeInfluencer(i.id)))}
                    trigger={(open) => (
                      <button type="button" onClick={open} aria-label={`Stop watching ${i.name}`} title="Stop watching" className="rounded p-1 text-fg-muted hover:text-negative">
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
