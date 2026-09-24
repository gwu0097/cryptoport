"use client";

import { RefreshCw, X } from "lucide-react";
import { filterWallets } from "@/lib/walletTagFilter";
import { syncLane } from "@/lib/syncLanes";
import { isEvmChainId } from "@/lib/adapters/evmChains";
import { Button } from "./ui/Button";
import { useSyncQueue } from "./jobs/SyncQueue";
import { useWalletsFilter } from "./wallets/WalletsFilterProvider";

interface SyncAllWallet {
  id: string;
  name: string;
  chain: string;
  address: string | null;
  notes: string | null;
  tags: { name: string }[];
  provider: string | null;
  mode: string;
}

/**
 * "Sync all wallets" — scoped to whatever the Wallets list's filter (tags +
 * search) is currently showing (see WalletsFilterProvider — the same filter
 * state WalletsTable's own rows use). A real request from actual use: many
 * long-term-holding wallets don't change often enough to re-sync on every
 * click, so filtering to e.g. "Main" first syncs only those.
 *
 * Runs through SyncQueueProvider: lanes by shared API, one wallet at a time
 * per lane, lanes in parallel. Shows "Syncing n / total" while it runs (each
 * row flips to its result as it lands), then a summary naming any wallet
 * that only partly synced or failed, with its reason.
 */
export function SyncAllWalletsButton({ wallets }: { wallets: SyncAllWallet[] }) {
  const { tagFilter, searchQuery } = useWalletsFilter();
  const { entries, active, start, dismiss } = useSyncQueue();
  const filtered = filterWallets(wallets, { tags: tagFilter, query: searchQuery }).filter((w) => w.mode === "auto");
  const isFiltered = tagFilter.length > 0 || searchQuery.trim() !== "";

  const all = Object.entries(entries).map(([id, e]) => ({ id, ...e }));
  const finished = all.filter((e) => e.state === "ok" || e.state === "partial" || e.state === "failed");
  const problems = all.filter((e) => e.state === "partial" || e.state === "failed");

  const label = isFiltered ? `Sync filtered (${filtered.length})` : "Sync all";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={active || filtered.length === 0}
        onClick={() =>
          start(
            filtered.map((w) => ({
              id: w.id,
              name: w.name,
              provider: w.provider,
              lane: syncLane(w, isEvmChainId),
            })),
          )
        }
      >
        <RefreshCw className={`size-3.5 ${active ? "animate-spin" : ""}`} aria-hidden="true" />
        {active ? `Syncing ${finished.length} / ${all.length}…` : label}
      </Button>
      {active && (
        <p className="max-w-xs text-right text-xs text-fg-muted">
          Wallets that share an API sync one at a time. Keep this tab open until it finishes.
        </p>
      )}
      {!active && all.length > 0 && (
        <div className="max-w-sm text-right text-xs">
          <p className="flex items-center justify-end gap-2 text-fg-muted">
            {problems.length === 0
              ? `All ${all.length} wallets synced.`
              : `${all.length - problems.length} of ${all.length} synced fully.`}
            <button type="button" onClick={dismiss} aria-label="Dismiss" className="hover:text-fg">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </p>
          {problems.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {problems.map((e) => (
                <li key={e.id} className={e.state === "failed" ? "text-negative" : "text-warning"} title={e.detail ?? undefined}>
                  {e.name}: {e.state === "failed" ? "couldn't sync, try again later" : "partly synced"}
                  {e.detail ? ` — ${e.detail.replace(/^(error|partial) ?[:—-]? ?/i, "").slice(0, 90)}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
