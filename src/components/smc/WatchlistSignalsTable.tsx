"use client";

import Link from "next/link";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { TokenIcon } from "@/components/TokenIcon";
import { usePersistedState } from "@/components/usePersistedState";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import type { WatchlistSignalRow } from "@/lib/smc/signals";
import { triggerFiresAt } from "@/lib/signals/triggers";
import { TIMEFRAMES, type ChartTimeframe } from "@/lib/smc/engine";
import { SignalTime } from "./SignalTime";
import { TriggerText } from "./TriggerText";

type SortKey = "ticker" | "state" | "lastSignal" | "distance";
type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Distance from the last price to an exact trigger price, as a % of the last
 * price. null when there's no exact trigger (blocked / values only). */
function distancePct(r: WatchlistSignalRow): number | null {
  if (r.trigger?.kind !== "price" || r.lastPrice === null || r.lastPrice <= 0) return null;
  return ((r.trigger.price - r.lastPrice) / r.lastPrice) * 100;
}

function sortValue(r: WatchlistSignalRow, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return r.ticker.toLowerCase();
    case "state":
      return r.state === null ? -1 : r.state.up ? 1 : 0;
    case "lastSignal":
      return r.lastSignal?.time ?? -Infinity;
    case "distance": {
      const d = distancePct(r);
      return d === null ? Infinity : Math.abs(d);
    }
  }
}

/** The forming bar/block would fire the trigger if it closed at the last
 * price (both bounds, incl. an SMA(200) floor). Shown explicitly: a bare
 * "+0.4%" doesn't say which side it's on. */
function firesAtCurrentPrice(r: WatchlistSignalRow): boolean {
  return r.trigger !== null && r.lastPrice !== null && triggerFiresAt(r.trigger, r.lastPrice);
}

export function WatchlistSignalsTable({
  rows,
  ind,
  tf,
  closeUnit,
  listQuery,
}: {
  rows: WatchlistSignalRow[];
  ind: string;
  tf: ChartTimeframe;
  closeUnit: string;
  listQuery: string;
}) {
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:signalsWatchlistSort", { key: "distance", dir: "asc" });
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
              <SortableHeader label="Last signal" sortKeyValue="lastSignal" sortKey={sort.key} sortDir={sort.dir} onSort={toggleSort} className={hideOnMobileClass} />
              <th className={thClass}>Next signal if this {closeUnit} closes…</th>
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
                      <Link
                        href={`/signals?ind=${ind}&coin=${encodeURIComponent(r.coin!)}&tf=${tf}${listQuery}`}
                        className="font-medium text-fg hover:text-accent"
                      >
                        {r.coin}
                      </Link>
                      {r.coin !== r.ticker && <span className="text-xs text-fg-muted">(per 1,000 {r.ticker})</span>}
                    </div>
                  </td>
                  <td className={tdClass}>
                    {r.error ? (
                      <span className="text-warning" title={r.error}>
                        {r.error.includes("429") ? "rate-limited, reload" : "error"}
                      </span>
                    ) : r.state === null ? (
                      <span className="text-fg-muted" title="Not enough Hyperliquid history at this timeframe for every input (e.g. SMA(200)) to be defined">
                        — {r.venueBars !== null ? `(${r.venueBars} bars)` : ""}
                      </span>
                    ) : (
                      <span className={r.state.up ? "text-positive" : "text-negative"}>{r.state.label}</span>
                    )}
                  </td>
                  <td className={`${tdClass} ${hideOnMobileClass}`}>
                    {r.lastSignal ? <SignalTime sec={r.lastSignal.time} side={r.lastSignal.side} barSeconds={TIMEFRAMES[tf].candleSeconds} /> : "—"}
                  </td>
                  <td className={`${tdClass} max-w-md`}>{r.trigger ? <TriggerText trigger={r.trigger} /> : "—"}</td>
                  <td className={`${tdClass} tabular-nums`}>
                    {d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(1)}%`}
                    {firesAtCurrentPrice(r) && (
                      <span
                        className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning"
                        title={`Price is already past the trigger — if the ${closeUnit} closed now, it would fire`}
                      >
                        fires at current price
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
