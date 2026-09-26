"use client";

import type { HoldingContext } from "@/lib/analytics/holdingContext";
import { formatCompactUsd, formatPercent, formatUsd } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { Panel } from "@/components/ui/Panel";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "value" | "change7d" | "change30d" | "fromHigh" | "volatility" | "beta" | "riskShare" | "volumeShare" | "marketCap" | "flags";
type Sort = { key: SortKey; dir: "asc" | "desc" };
type Filter = "all" | "flagged";

const DEFAULT_SORT: Sort = { key: "value", dir: "desc" };

function sortValue(h: HoldingContext, key: SortKey): number {
  const v = key === "flags" ? h.flags.length : key === "value" ? h.valueUsd : h[key];
  return v ?? -Infinity;
}

const pct = (x: number | null, digits = 0) => (x === null ? "—" : `${(x * 100).toFixed(digits)}%`);
const tone = (n: number | null) => (n === null ? "text-fg-muted" : n > 0 ? "text-positive" : n < 0 ? "text-negative" : "text-fg");

/** Where the price sits in its 90-day range: a track with a dot. */
function RangeBar({ position }: { position: number | null }) {
  if (position === null) return <span className="text-fg-muted">—</span>;
  return (
    <span className="relative block h-1.5 w-20 rounded-full bg-surface-raised" title={`${Math.round(position * 100)}% of the way from the 90-day low to the high`}>
      <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${position * 100}%` }} />
    </span>
  );
}

/**
 * Each holding with the context for deciding what to do with it
 * (analytics/holdingContext.ts) — its size, recent moves, where it sits in
 * its 90-day range, how much of the portfolio's risk it carries and how easy
 * it is to exit. Observations, not advice.
 */
export function HoldingContextTable({ holdings, smallHoldings }: { holdings: HoldingContext[]; smallHoldings: { count: number; usd: number } }) {
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:analyticsHoldingsSort", DEFAULT_SORT);
  const [filter, setFilter] = usePersistedState<Filter>("cryptoport:analyticsHoldingsFilter", "all");
  const { key: sortKey, dir: sortDir } = sort;
  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  const flaggedCount = holdings.filter((h) => h.flags.length > 0).length;
  const rows = holdings
    .filter((h) => filter === "all" || h.flags.length > 0)
    .sort((a, b) => {
      const cmp = sortValue(a, sortKey) - sortValue(b, sortKey);
      return sortDir === "desc" ? -cmp : cmp;
    });
  const header = (label: string, key: SortKey, mobile = false) => (
    <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={mobile ? "" : hideOnMobileClass} />
  );

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center justify-between gap-2">
          Your holdings in context
          <ToggleGroup
            options={[
              { key: "all", label: `All (${holdings.length})` },
              { key: "flagged", label: `Flagged (${flaggedCount})` },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </span>
      }
      description="Where each holding stands — size, momentum, its 90-day range, the risk it carries and how easily it could be sold. Flags are observations with fixed thresholds, not advice."
      padding
    >
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>Asset</th>
              {header("Value", "value", true)}
              {header("7d", "change7d")}
              {header("30d", "change30d")}
              {header("From 90d high", "fromHigh")}
              <th className={`${thClass} ${hideOnMobileClass}`}>90d range</th>
              {header("Volatility", "volatility")}
              {header("Beta", "beta")}
              {header("Risk share", "riskShare")}
              {header("Of 24h volume", "volumeShare")}
              {header("Market cap", "marketCap")}
              {header("Flags", "flags", true)}
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.key} className={trClass}>
                <td className={tdClass}>
                  <span className="flex items-center gap-2">
                    {h.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={h.iconUrl} alt="" className="size-5 rounded-full" />
                    ) : (
                      <span className="size-5 rounded-full bg-surface-raised" />
                    )}
                    <span className="font-medium text-fg">{h.ticker}</span>
                    {h.cashLike && <span className="text-xs text-fg-muted">cash-like</span>}
                  </span>
                </td>
                <td className={`${tdClass} tabular-nums`}>
                  {formatUsd(h.valueUsd)}
                  <div className="text-xs text-fg-muted">{pct(h.weight, 1)} of portfolio</div>
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums ${tone(h.change7d)}`}>{formatPercent(h.change7d)}</td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums ${tone(h.change30d)}`}>{formatPercent(h.change30d)}</td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums ${tone(h.fromHigh)}`}>{pct(h.fromHigh)}</td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>
                  <RangeBar position={h.rangePosition} />
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{pct(h.volatility)}</td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{h.beta === null ? "—" : h.beta.toFixed(2)}</td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{pct(h.riskShare, 1)}</td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                  {h.volumeShare === null ? "—" : h.volumeShare < 0.0001 ? "<0.01%" : pct(h.volumeShare, 2)}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{formatCompactUsd(h.marketCap)}</td>
                <td className={tdClass}>
                  <span className="flex flex-wrap gap-1">
                    {h.flags.map((f) => (
                      <span key={f.id} title={f.detail} className="rounded-full border border-warning/40 px-2 py-0.5 text-xs whitespace-nowrap text-warning">
                        {f.label}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {smallHoldings.count > 0 && (
        <p className="mt-3 text-xs text-fg-muted">
          {smallHoldings.count} holdings under 0.1% of the portfolio ({formatUsd(smallHoldings.usd)} together) aren&apos;t listed.
        </p>
      )}
    </Panel>
  );
}
