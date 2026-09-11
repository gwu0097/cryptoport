"use client";

import { useMemo, type ReactNode } from "react";
import type { StitchedPoint } from "@/lib/analytics";
import { formatUsd, formatUsdSigned, formatPercent } from "@/lib/format";
import { scalePoints, linePath, areaPath } from "@/lib/chart";
import { usePersistedState } from "../usePersistedState";
import { Panel } from "../ui/Panel";
import { Button } from "../ui/Button";
import { selectClass } from "../ui/Field";

const WIDTH = 600;
const HEIGHT = 220;
const PADDING_Y = 16;

export interface WalletSeriesOption {
  /** "all" for the blended total across every wallet. */
  id: string;
  name: string;
  points: StitchedPoint[];
  coveragePct: number;
  uncoveredCount: number;
}

type RangeKey = "7d" | "30d" | "90d" | "1y" | "all";

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", days: null },
];

const WALLET_STORAGE_KEY = "cryptoport:analyticsWallet";
const RANGE_STORAGE_KEY = "cryptoport:analyticsRange";

function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function sliceToRange(points: StitchedPoint[], days: number | null): StitchedPoint[] {
  if (days === null || points.length === 0) return points;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  return points.filter((p) => p.date >= cutoffDate);
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((opt) => (
        <Button
          key={opt.key}
          type="button"
          variant={value === opt.key ? "primary" : "secondary"}
          size="sm"
          className={value === opt.key ? "" : "border-none bg-transparent"}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

export function PerformanceChart({
  options,
  emptyStateAction,
}: {
  options: WalletSeriesOption[];
  /** Rendered instead of the chart when no wallet has any price-history
   * data cached yet — the "Backfill history" CTA, owned by the page since
   * it's a server action form. */
  emptyStateAction: ReactNode;
}) {
  const [walletId, setWalletId] = usePersistedState(WALLET_STORAGE_KEY, "all");
  const [range, setRange] = usePersistedState<RangeKey>(RANGE_STORAGE_KEY, "90d");

  const selected = options.find((o) => o.id === walletId) ?? options[0];
  const rangeDays = RANGES.find((r) => r.key === range)?.days ?? 90;

  const sliced = useMemo(() => sliceToRange(selected.points, rangeDays), [selected, rangeDays]);

  const hasAnyHistory = options.some((o) => o.points.length > 0);

  if (!hasAnyHistory) {
    return (
      <Panel title="Performance">
        <p className="text-sm text-fg-muted">
          No historical prices cached yet — fetch up to a year of history for your current holdings to see
          how their value has moved over time.
        </p>
        <div className="mt-3">{emptyStateAction}</div>
      </Panel>
    );
  }

  return (
    <Panel title="Performance">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {options.length > 1 && (
          // A button per wallet stopped fitting once there were more than
          // a handful — a native select scales to any number of wallets
          // without overflowing the page, and (unlike a custom dropdown)
          // gets type-to-jump search for free from the browser/OS, no
          // extra combobox component needed.
          <select
            value={selected.id}
            onChange={(e) => setWalletId(e.target.value)}
            className={`${selectClass} w-auto max-w-56`}
            aria-label="Wallet"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
        <ToggleGroup options={RANGES.map((r) => ({ key: r.key, label: r.label }))} value={range} onChange={setRange} />
      </div>

      {sliced.length < 2 ? (
        <p className="mt-4 text-sm text-fg-muted">Not enough data in this range yet — try a wider one.</p>
      ) : (
        <Chart points={sliced} />
      )}

      <div className="mt-3 space-y-1 text-xs text-fg-muted">
        {selected.coveragePct < 100 && (
          <p>
            Estimate based on {selected.coveragePct.toFixed(0)}% of current value
            {selected.uncoveredCount > 0 &&
              ` — ${selected.uncoveredCount} holding${selected.uncoveredCount === 1 ? "" : "s"} (manual entries, DeFi positions) couldn't be priced historically`}
            .
          </p>
        )}
        <p>
          Dashed portion is estimated from today&rsquo;s holdings at historical prices — it doesn&rsquo;t
          reflect past buys or sells. Solid portion is real, captured daily.
        </p>
      </div>
    </Panel>
  );
}

function Chart({ points }: { points: StitchedPoint[] }) {
  const coords = scalePoints(
    points.map((p) => p.total),
    WIDTH,
    HEIGHT,
    PADDING_Y,
  );

  const seamIndex = points.findIndex((p) => p.kind === "real");
  const estimatedCoords = seamIndex === -1 ? coords : coords.slice(0, seamIndex + 1);
  const realCoords = seamIndex === -1 ? [] : coords.slice(seamIndex);

  const first = points[0].total;
  const last = points[points.length - 1].total;
  const deltaUsd = last - first;
  const deltaPct = first !== 0 ? (deltaUsd / first) * 100 : 0;
  const trendClass = deltaUsd >= 0 ? "text-positive" : "text-negative";

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums text-fg">{formatUsd(last)}</span>
        <span className={`text-sm font-medium tabular-nums ${trendClass}`}>
          {formatUsdSigned(deltaUsd)} ({formatPercent(deltaPct)})
        </span>
      </div>
      <div className={trendClass}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="mt-2 h-52 w-full"
          role="img"
          aria-label="Portfolio value over time"
        >
          {estimatedCoords.length > 1 && (
            <path
              d={linePath(estimatedCoords)}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeDasharray="5,5"
              strokeOpacity={0.6}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {realCoords.length > 1 && (
            <>
              <path d={areaPath(coords, WIDTH, HEIGHT)} fill="currentColor" fillOpacity={0.08} stroke="none" />
              <path
                d={linePath(realCoords)}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          {realCoords.length === 0 && (
            <path d={areaPath(coords, WIDTH, HEIGHT)} fill="currentColor" fillOpacity={0.08} stroke="none" />
          )}
        </svg>
      </div>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{shortDate(points[0].date)}</span>
        {seamIndex > 0 && <span>snapshots start {shortDate(points[seamIndex].date)}</span>}
        <span>{shortDate(points[points.length - 1].date)}</span>
      </div>
    </div>
  );
}
