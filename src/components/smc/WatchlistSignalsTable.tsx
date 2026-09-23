"use client";

import Link from "next/link";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { TokenIcon } from "@/components/TokenIcon";
import { usePersistedState } from "@/components/usePersistedState";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { formatPrice } from "@/lib/format";
import type { WatchlistSignalRow } from "@/lib/smc/signals";
import { TIMEFRAMES, type ChartTimeframe } from "@/lib/smc/engine";
import { SignalTime } from "./SignalTime";

type SortKey = "ticker" | "state" | "lastFlip" | "distance";
type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Distance from the last price to the trigger, as a % of the last price —
 * how far the forming block's close would have to be from here to flip. */
function distancePct(r: WatchlistSignalRow): number | null {
  if (r.triggerPrice === null || r.lastPrice === null || r.lastPrice <= 0) return null;
  return ((r.triggerPrice - r.lastPrice) / r.lastPrice) * 100;
}

function sortValue(r: WatchlistSignalRow, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return r.ticker.toLowerCase();
    case "state":
      return r.bull === null ? -1 : r.bull ? 1 : 0;
    case "lastFlip":
      return r.lastFlipTime ?? -Infinity;
    case "distance": {
      const d = distancePct(r);
      return d === null ? Infinity : Math.abs(d);
    }
  }
}

/** The forming block would flip the state if it closed at the last price —
 * i.e. price is already past the trigger (above it for a Buy, below for a
 * Sell). Shown explicitly: a bare "+0.4%" doesn't say which side it's on. */
function flipsAtCurrentPrice(r: WatchlistSignalRow): boolean {
  if (r.triggerPrice === null || r.lastPrice === null || !r.triggerFlipTo) return false;
  return r.triggerFlipTo === "BUY" ? r.lastPrice > r.triggerPrice : r.lastPrice < r.triggerPrice;
}

export function WatchlistSignalsTable({ rows, tf, listQuery }: { rows: WatchlistSignalRow[]; tf: ChartTimeframe; listQuery: string }) {
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:smcWatchlistSort", { key: "distance", dir: "asc" });
  const toggleSort = (key: SortKey) =>
    setSort(key === sort.key ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });

  const listed = rows.filter((r) => r.coin);
  const unlisted = rows.filter((r) => !r.coin).map((r) => r.ticker);
  const sorted = [...listed].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sort.dir === "desc" ? -cmp : cmp;
  });

  return (
    <>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <SortableHeader label="Token" sortKeyValue="ticker" sortKey={sort.key} sortDir={sort.dir} onSort={toggleSort} />
              <SortableHeader label="State" sortKeyValue="state" sortKey={sort.key} sortDir={sort.dir} onSort={toggleSort} />
              <SortableHeader label="Last signal" sortKeyValue="lastFlip" sortKey={sort.key} sortDir={sort.dir} onSort={toggleSort} className={hideOnMobileClass} />
              <th className={thClass}>Next flip if block closes…</th>
              <SortableHeader label="Distance" sortKeyValue="distance" sortKey={sort.key} sortDir={sort.dir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const d = distancePct(r);
              return (
                <tr key={r.ticker} className={trClass}>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <TokenIcon ticker={r.ticker} url={r.imageUrl} />
                      <Link href={`/signals?coin=${encodeURIComponent(r.coin!)}&tf=${tf}${listQuery}`} className="font-medium text-fg hover:text-accent">
                        {r.coin}
                      </Link>
                      {r.coin !== r.ticker && <span className="text-xs text-fg-muted">(per 1,000 {r.ticker})</span>}
                    </div>
                  </td>
                  <td className={tdClass}>
                    {r.error ? (
                      <span className="text-warning" title={r.error}>error</span>
                    ) : r.bull === null ? (
                      <span className="text-fg-muted">—</span>
                    ) : (
                      <span className={r.bull ? "text-positive" : "text-negative"}>{r.bull ? "Bull" : "Bear"}</span>
                    )}
                  </td>
                  <td className={`${tdClass} ${hideOnMobileClass}`}>
                    {r.lastFlipSide && r.lastFlipTime !== null ? (
                      <SignalTime sec={r.lastFlipTime} side={r.lastFlipSide} barSeconds={TIMEFRAMES[tf].candleSeconds} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={tdClass}>
                    {r.triggerPrice !== null && r.triggerFlipTo ? (
                      <span className={r.triggerFlipTo === "BUY" ? "text-positive" : "text-negative"}>
                        {r.triggerFlipTo === "BUY" ? "above" : "below"} {formatPrice(r.triggerPrice)} → {r.triggerFlipTo === "BUY" ? "Buy" : "Sell"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${tdClass} tabular-nums`}>
                    {d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(1)}%`}
                    {flipsAtCurrentPrice(r) && (
                      <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning" title="Price is already past the trigger — if the block closed now, it would flip">
                        flips at current price
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unlisted.length > 0 && (
        <p className="mt-3 text-xs text-fg-muted">
          Not listed as a Hyperliquid perp (no signal): {unlisted.join(", ")}
        </p>
      )}
    </>
  );
}
