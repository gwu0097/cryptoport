"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { WatchDayActivity, WatchFeedInfluencer, WatchGroup, WatchMovementView } from "@/lib/watchQuery";
import { inputClass } from "../ui/Field";
import { Panel } from "../ui/Panel";
import { ToggleGroup } from "../ui/ToggleGroup";
import { usePersistedState } from "../usePersistedState";
import { ActivityFeed } from "../walletWatch/ActivityFeed";
import { ActivityCheckButton, DayActivity } from "../walletWatch/DayActivity";

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

  return (
    <Panel
      density="compact"
      className="h-full"
      title={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <Link href={href} className="whitespace-nowrap hover:text-accent">
            Wallet Watch
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
      }
      actions={
        <>
          <ActivityCheckButton influencerIds={[...ids]} />
          <Link href={href} aria-label="View all — Wallet Watch" className="text-fg-muted transition hover:text-accent">
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        </>
      }
    >
      <div className="mb-3">
        <ToggleGroup
          options={[
            { key: "today", label: "Since this morning" },
            { key: "movements", label: "Between reads" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === "today" ? (
        <DayActivity
          coins={day.coins.filter((c) => ids.has(c.influencerId))}
          checkedAt={[...ids].map((id) => day.checkedAt[id]).filter(Boolean).sort().at(-1) ?? null}
          issues={day.issues.filter((i) => ids.has(i.influencerId))}
          liveIds={day.liveIds}
          influencerIds={[...ids]}
          serverNowSec={serverNowSec}
          showButton={false}
        />
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
