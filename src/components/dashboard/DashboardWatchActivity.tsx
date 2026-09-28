"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { WatchDayLine, WatchFeedInfluencer, WatchGroup, WatchMovementView } from "@/lib/watchQuery";
import { inputClass } from "../ui/Field";
import { Panel } from "../ui/Panel";
import { usePersistedState } from "../usePersistedState";
import { ActivityFeed } from "../walletWatch/ActivityFeed";
import { ActivityCheckButton, DayActivity } from "../walletWatch/DayActivity";

const SHOWN = 15;

/**
 * Wallet Watch's activity feed on the Dashboard (a lens: the same movements
 * Wallet Watch shows), filtered by one of the user's groups — the picker
 * sits in the title like the watchlist movers'. The choice is remembered.
 * Above the feed, the activity check for the group (DayActivity).
 */
export function DashboardWatchActivity({
  movements,
  groups,
  influencers,
  day,
  serverNowSec,
}: {
  movements: WatchMovementView[];
  groups: WatchGroup[];
  influencers: WatchFeedInfluencer[];
  day: { lines: WatchDayLine[]; checkedAt: Record<string, string>; issues: { influencerId: string; address: string; status: string }[] };
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
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
            <Link href={href} className="whitespace-nowrap hover:text-accent">
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
          <span className="flex items-center gap-2">
            <ActivityCheckButton influencerIds={[...ids]} />
            <Link href={href} aria-label="View all — Wallet Watch" className="text-fg-muted transition hover:text-accent">
              <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
          </span>
        </div>
      }
      description="What the wallets you watch bought and sold between reads, newest first."
      className="mb-4"
    >
      <DayActivity
        lines={day.lines.filter((l) => ids.has(l.influencerId))}
        checkedAt={[...ids].map((id) => day.checkedAt[id]).filter(Boolean).sort().at(-1) ?? null}
        issues={day.issues.filter((i) => ids.has(i.influencerId))}
        influencerIds={[...ids]}
        serverNowSec={serverNowSec}
        showButton={false}
      />
      <ActivityFeed movements={shown} serverNowSec={serverNowSec} />
    </Panel>
  );
}
