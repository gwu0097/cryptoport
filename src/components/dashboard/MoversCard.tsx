"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Panel } from "../ui/Panel";
import { ToggleGroup } from "../ui/ToggleGroup";
import { usePersistedState } from "../usePersistedState";
import { MoverRows, type MoverItem } from "./MoverList";

type Source = "holdings" | "watchlist";
type Side = "gainers" | "losers";

/**
 * The 24h movers in one card: gainers and losers side by side (owner
 * 2026-09-29: switching between them was a pain), for holdings or the
 * watchlist (a tab — the choice is remembered per browser).
 */
export function MoversCard({
  holdings,
  watchlist,
  watchlistFilter,
  holdingsHref,
  watchlistHref,
}: {
  holdings: Record<Side, MoverItem[]>;
  watchlist: Record<Side, MoverItem[]>;
  /** The watchlist picker (Dashboard's ?list=), shown on the Watchlist tab. */
  watchlistFilter?: ReactNode;
  holdingsHref: Record<Side, string>;
  watchlistHref: Record<Side, string>;
}) {
  const [source, setSource] = usePersistedState<Source>("cryptoport:dashboardMoversSource", "holdings");
  const lists = source === "holdings" ? holdings : watchlist;
  const hrefs = source === "holdings" ? holdingsHref : watchlistHref;
  return (
    <Panel
      density="compact"
      className="h-full"
      title="Top movers (24h)"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToggleGroup
          options={[
            { key: "holdings", label: "Holdings" },
            { key: "watchlist", label: "Watchlist" },
          ]}
          value={source}
          onChange={setSource}
        />
        {source === "watchlist" && watchlistFilter}
      </div>
      {/* Two columns only when the card is wide enough for both (a container
          query, not the screen width: the card's width depends on the grid). */}
      <div className="@container">
      <div className="grid gap-x-6 gap-y-4 @[34rem]:grid-cols-2">
        {(["gainers", "losers"] as const).map((side) => (
          <div key={side} className="min-w-0">
            <Link href={hrefs[side]} className="mb-2 flex items-center justify-between text-xs font-medium text-fg-muted hover:text-accent">
              {side === "gainers" ? "Gainers" : "Losers"}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Link>
            <MoverRows items={lists[side]} />
          </div>
        ))}
      </div>
      </div>
    </Panel>
  );
}
