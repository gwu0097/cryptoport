"use client";

import { useMemo, useRef, useState } from "react";
import { formatUsd, formatUsdSigned, formatPercent } from "@/lib/format";
import { scalePoints, linePath, areaPath, sliceToRange, rangeChange, CHART_RANGES, type ChartRangeKey } from "@/lib/chart";
import { usePersistedState } from "../usePersistedState";
import { useHideBalance } from "../HideBalanceProvider";
import { ToggleGroup } from "../ui/ToggleGroup";

const WIDTH = 600;
const HEIGHT = 220;
const PADDING_Y = 16;

export interface ValueChartPoint {
  date: string;
  total: number;
  /** "estimated" points render as a lighter dashed line, "real" as solid —
   * a series that's entirely "real" (Dashboard's own daily snapshots, no
   * pre-history estimate) just never shows a dashed portion at all, no
   * separate flag needed. */
  kind: "real" | "estimated";
}

function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function longDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A value-over-time chart with a range picker (7D/30D/90D/1Y/All) and a
 * Robinhood-style hover scrub: the headline number/date swap to whatever
 * point the cursor is nearest, with a vertical guide line + dot on the
 * chart — no floating tooltip box (avoids the positioning-near-cursor-
 * without-clipping problem entirely). Shared by Dashboard's
 * ValueHistoryChart and Analytics' PerformanceChart — the second of those
 * to need this exact control is what triggered extracting it here (see
 * chart.ts's own doc comment) rather than a second hand-copied version.
 *
 * `rangeStorageKey` is the only thing that has to differ between callers
 * (each page's own remembered range choice); everything else about the
 * control is identical across every value-series chart in this app.
 *
 * Privacy-mode masking (useHideBalance) lives here, not in each caller —
 * every headline dollar figure this component shows (default and
 * hover-scrubbed) is derived from the user's own total, so it gets masked
 * the same way TotalValuePanel's own headline does.
 */
export function ValueChart({
  points,
  rangeStorageKey,
  emptyRangeMessage = "Not enough data in this range yet — try a wider one.",
}: {
  points: ValueChartPoint[];
  rangeStorageKey: string;
  emptyRangeMessage?: string;
}) {
  const [range, setRange] = usePersistedState<ChartRangeKey>(rangeStorageKey, "90d");
  const rangeDays = CHART_RANGES.find((r) => r.key === range)?.days ?? 90;
  const sliced = useMemo(() => sliceToRange(points, rangeDays), [points, rangeDays]);

  return (
    <div>
      <div className="flex justify-end">
        <ToggleGroup
          options={CHART_RANGES.map((r) => ({ key: r.key, label: r.label }))}
          value={range}
          onChange={setRange}
        />
      </div>
      {sliced.length < 2 ? (
        <p className="mt-4 text-sm text-fg-muted">{emptyRangeMessage}</p>
      ) : (
        <Chart points={sliced} />
      )}
    </div>
  );
}

function Chart({ points }: { points: ValueChartPoint[] }) {
  const { hidden } = useHideBalance();

  const coords = scalePoints(
    points.map((p) => p.total),
    WIDTH,
    HEIGHT,
    PADDING_Y,
  );

  const seamIndex = points.findIndex((p) => p.kind === "real");
  const estimatedCoords = seamIndex === -1 ? coords : coords.slice(0, seamIndex + 1);
  const realCoords = seamIndex === -1 ? [] : coords.slice(seamIndex);

  const last = points[points.length - 1].total;
  // Chained across the estimate→real switch (see rangeChange).
  const change = rangeChange(points);
  const trendClass = (change?.usd ?? 0) >= 0 ? "text-positive" : "text-negative";

  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  function hoverAt(clientX: number) {
    const el = containerRef.current;
    if (!el || points.length < 2) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHoverIndex(Math.round(fraction * (points.length - 1)));
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredCoord = hoverIndex !== null ? coords[hoverIndex] : null;

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        {hovered ? (
          <>
            <span className="text-2xl font-semibold tabular-nums text-fg">
              {hidden ? "••••••" : formatUsd(hovered.total)}
            </span>
            <span className="text-sm font-medium text-fg-muted">
              {longDate(hovered.date)}
              {hovered.kind === "estimated" && " · estimated"}
            </span>
          </>
        ) : (
          <>
            <span className="text-2xl font-semibold tabular-nums text-fg">{hidden ? "••••••" : formatUsd(last)}</span>
            <span
              className={`text-sm font-medium tabular-nums ${change ? trendClass : "text-fg-muted"}`}
              title={change?.chained ? "Estimated and real portions linked by their own % moves; the step where real snapshots begin isn't counted" : undefined}
            >
              {!change ? "—" : hidden ? formatPercent(change.pct) : `${formatUsdSigned(change.usd)} (${formatPercent(change.pct)})`}
              {change?.chained && "*"}
            </span>
          </>
        )}
      </div>
      {/* mt-2 lives on this wrapper, not the <svg> below — a margin on the
          svg itself risks collapsing into this div's own box (block-level
          margin collapsing), which would offset hoverAt's/the overlay
          dot's percentage math against the svg's actual rendered top. This
          div's box is exactly the svg's box, nothing else. */}
      <div
        ref={containerRef}
        className={`relative mt-2 touch-none ${trendClass}`}
        onMouseMove={(e) => hoverAt(e.clientX)}
        onMouseLeave={() => setHoverIndex(null)}
        onTouchStart={(e) => hoverAt(e.touches[0].clientX)}
        onTouchMove={(e) => hoverAt(e.touches[0].clientX)}
        onTouchEnd={() => setHoverIndex(null)}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="block h-52 w-full"
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
          {hoveredCoord && (
            <line
              x1={hoveredCoord.x}
              x2={hoveredCoord.x}
              y1={0}
              y2={HEIGHT}
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* An HTML dot, not an SVG <circle> — the SVG's viewBox is
            stretched non-uniformly (preserveAspectRatio="none", a
            600x220 box filling whatever width the panel has), so a
            <circle> renders as a squashed ellipse. Percentages here are
            undistorted: both axes map linearly from the same 0..WIDTH /
            0..HEIGHT space the SVG paths use, onto this plain HTML
            container's real width/height. */}
        {hoveredCoord && (
          <div
            aria-hidden="true"
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-current"
            style={{
              left: `${(hoveredCoord.x / WIDTH) * 100}%`,
              top: `${(hoveredCoord.y / HEIGHT) * 100}%`,
              borderColor: "var(--color-surface)",
            }}
          />
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{shortDate(points[0].date)}</span>
        {seamIndex > 0 && <span>snapshots start {shortDate(points[seamIndex].date)}</span>}
        <span>{shortDate(points[points.length - 1].date)}</span>
      </div>
    </div>
  );
}
