"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { WatchDayActivity, WatchFeedInfluencer, WatchGroup, WatchMovementView } from "@/lib/watchQuery";
import { inputClass } from "../ui/Field";
import { Panel } from "../ui/Panel";
import { ToggleGroup } from "../ui/ToggleGroup";
import { usePersistedState } from "../usePersistedState";
import { ActivityFeed } from "../walletWatch/ActivityFeed";
import { ActivityCheckButton, DAY_ACTIVITY_NOTE, DayStatus, DayTable, useDayActivity } from "../walletWatch/DayActivity";
import { InfoTooltip } from "../ui/InfoTooltip";

const SHOWN = 30;

/**
 * Wallet Watch's activity feed on the Dashboard (a lens: the same movements
 * Wallet Watch shows), filtered by one of the user's groups — the picker
 * sits in the title like the watchlist movers'. The choice is remembered.
 * Two tabs (owner 2026-09-29, a dashboard not a scroll): today's trades per
 * coin (DayActivity) and the movements between reads (ActivityFeed), each
 * capped in height on wider screens — Wallet Watch has the full history.
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
  day: WatchDayActivity;
  serverNowSec: number;
}) {
  const [group, setGroup] = usePersistedState<string>("cryptoport:dashboardWatchGroup", "all");
  const selected = groups.find((g) => g.id === group) ?? null;
  const inGroup = selected ? influencers.filter((i) => i.groupIds.includes(selected.id)) : influencers;
  const ids = new Set(inGroup.map((i) => i.id));
  const shown = movements.filter((m) => ids.has(m.influencerId)).slice(0, SHOWN);
  const href = selected ? `/wallet-watch?group=${selected.id}` : "/wallet-watch";

  const [tab, setTab] = usePersistedState<"today" | "movements">("cryptoport:dashboardWatchTab", "today");
  const influencerIds = [...ids];
  // The day's lines, listening for live updates only while that tab shows.
  const today = useDayActivity({
    coins: day.coins.filter((c) => ids.has(c.influencerId)),
    checkedAt: influencerIds.map((id) => day.checkedAt[id]).filter(Boolean).sort().at(-1) ?? null,
    issues: day.issues.filter((i) => ids.has(i.influencerId)),
    liveIds: day.liveIds,
    influencerIds,
    enabled: tab === "today",
  });

  // One header row (owner 2026-09-29: no band of empty header, no row per
  // control): the title and group, then the tabs and the day's status, then
  // Refresh activity. It wraps on a phone.
  return (
    <Panel
      density="compact"
      className="flex h-full flex-col"
      title={
        <span className="flex items-center gap-x-1.5">
          <Link href={href} className="whitespace-nowrap hover:text-accent">
            Wallet Watch
          </Link>
          <span className="text-fg-muted">·</span>
          <select
            value={selected ? selected.id : "all"}
            onChange={(e) => setGroup(e.target.value)}
            className={`${inputClass} w-auto min-w-0 max-w-[11rem] px-2 py-1 text-xs font-semibold`}
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
      toolbar={
        <>
          <ToggleGroup
            options={[
              { key: "today", label: "Since this morning" },
              { key: "movements", label: "Between reads" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "today" && <DayStatus live={today.live} watch={today.watch} checkedAt={today.checkedAt} issues={today.issues} serverNowSec={serverNowSec} reload={today.reload} reloading={today.reloading} />}
          <InfoTooltip>{tab === "today" ? DAY_ACTIVITY_NOTE : "Each wallet's changes between its daily reads, newest first — the full history is on Wallet Watch."}</InfoTooltip>
        </>
      }
      actions={
        <>
          <ActivityCheckButton influencerIds={influencerIds} />
          <Link href={href} aria-label="View all — Wallet Watch" className="text-fg-muted transition hover:text-accent">
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        </>
      }
    >
      {tab === "today" ? (
        <DayTable coins={today.coins} latest={today.latest} checkedAt={today.checkedAt} live={today.live} serverNowSec={serverNowSec} dense />
      ) : (
        // Capped on wider screens (its own scroll); a phone shows the first
        // lines and links to the rest instead of a scroll inside a scroll.
        <div className="sm:max-h-[34rem] sm:overflow-y-auto">
          <ActivityFeed movements={shown} serverNowSec={serverNowSec} />
          <Link href={href} className="mt-2 inline-block text-xs text-accent hover:underline sm:hidden">
            All movements in Wallet Watch →
          </Link>
        </div>
      )}
    </Panel>
  );
}
