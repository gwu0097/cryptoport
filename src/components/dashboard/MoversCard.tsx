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
 * The 24h movers in one card: holdings or watchlist, gainers or losers
 * (tabs for alternatives of the same kind — four stacked lists took a
 * screen of their own). The choice is remembered per browser.
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
  const [side, setSide] = usePersistedState<Side>("cryptoport:dashboardMoversSide", "gainers");
  const items = (source === "holdings" ? holdings : watchlist)[side];
  const href = (source === "holdings" ? holdingsHref : watchlistHref)[side];
  return (
    <Panel
      density="compact"
      className="h-full"
      title="Top movers (24h)"
      actions={
        <Link href={href} aria-label="View all" className="text-fg-muted transition hover:text-accent">
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      }
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
        <ToggleGroup
          options={[
            { key: "gainers", label: "Gainers" },
            { key: "losers", label: "Losers" },
          ]}
          value={side}
          onChange={setSide}
        />
        {source === "watchlist" && watchlistFilter}
      </div>
      <MoverRows items={items} />
    </Panel>
  );
}
