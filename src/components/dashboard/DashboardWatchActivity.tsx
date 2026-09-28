"use client";

import Link from "next/link";
import type { WatchGroup, WatchMovementView } from "@/lib/watchQuery";
import { inputClass } from "../ui/Field";
import { Panel } from "../ui/Panel";
import { usePersistedState } from "../usePersistedState";
import { ActivityFeed } from "../walletWatch/ActivityFeed";

const SHOWN = 15;

/**
 * Wallet Watch's activity feed on the Dashboard (a lens: the same movements
 * Wallet Watch shows), filtered by one of the user's groups like the
 * watchlist movers are by watchlist. The choice is remembered.
 */
export function DashboardWatchActivity({
  movements,
  groups,
  groupsOf,
  serverNowSec,
}: {
  movements: WatchMovementView[];
  groups: WatchGroup[];
  /** influencerId → the groups it's in. */
  groupsOf: Record<string, string[]>;
  serverNowSec: number;
}) {
  const [group, setGroup] = usePersistedState<string>("cryptoport:dashboardWatchGroup", "all");
  const selected = groups.find((g) => g.id === group) ?? null;
  const shown = (selected ? movements.filter((m) => groupsOf[m.influencerId]?.includes(selected.id)) : movements).slice(0, SHOWN);

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center justify-between gap-2">
          <Link href={selected ? `/wallet-watch?group=${selected.id}` : "/wallet-watch"} className="hover:underline">
            Wallet Watch activity
          </Link>
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
      }
      description="What the wallets you watch bought and sold between reads, newest first."
      className="mb-4"
    >
      <ActivityFeed movements={shown} serverNowSec={serverNowSec} />
    </Panel>
  );
}
