"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { WatchFeedInfluencer, WatchGroup, WatchMovementView } from "@/lib/watchQuery";
import { inputClass } from "../ui/Field";
import { Panel } from "../ui/Panel";
import { usePersistedState } from "../usePersistedState";
import { ActivityFeed } from "../walletWatch/ActivityFeed";

const SHOWN = 15;

/**
 * Wallet Watch's activity feed on the Dashboard (a lens: the same movements
 * Wallet Watch shows), filtered by one of the user's groups — the picker
 * sits in the title like the watchlist movers'. The choice is remembered.
 * (Its refresh comes with the transaction check, docs/wallet-watch/PLAN.md.)
 */
export function DashboardWatchActivity({
  movements,
  groups,
  influencers,
  serverNowSec,
}: {
  movements: WatchMovementView[];
  groups: WatchGroup[];
  influencers: WatchFeedInfluencer[];
  serverNowSec: number;
}) {
  const [group, setGroup] = usePersistedState<string>("cryptoport:dashboardWatchGroup", "all");
  const selected = groups.find((g) => g.id === group) ?? null;
  const inGroup = selected ? influencers.filter((i) => i.groupIds.includes(selected.id)) : influencers;
  const ids = new Set(inGroup.map((i) => i.id));
  const shown = movements.filter((m) => ids.has(m.influencerId)).slice(0, SHOWN);
  const href = selected ? `/wallet-watch?group=${selected.id}` : "/wallet-watch";

  return (
    <Panel
      title={
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link href={href} className="truncate hover:text-accent">
              Wallet Watch activity
            </Link>
            <span className="text-fg-muted">·</span>
            <select
              value={selected ? selected.id : "all"}
              onChange={(e) => setGroup(e.target.value)}
              className={`${inputClass} w-auto max-w-[11rem] px-2 py-1 text-xs font-semibold`}
            >
              <option value="all">All groups</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </span>
          <Link href={href} aria-label="View all — Wallet Watch" className="text-fg-muted transition hover:text-accent">
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        </div>
      }
      description="What the wallets you watch bought and sold between reads, newest first."
      className="mb-4"
    >
      <ActivityFeed movements={shown} serverNowSec={serverNowSec} />
    </Panel>
  );
}
