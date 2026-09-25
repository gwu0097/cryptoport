// Pure SVG scale/path math (+ the date-range slicing below) — no React, no
// DOM. Both were extracted from Analytics' PerformanceChart once a second
// caller (Dashboard's ValueHistoryChart, via the shared ValueChart
// component both now render through) needed the identical logic —
// CLAUDE.md's stated threshold for pulling shared code out.

export interface ChartPoint {
  x: number;
  y: number;
}

/** Scales a series of values into SVG coordinates, left-to-right, fit to
 * [0, width] x [paddingY, height - paddingY]. A single point centers at
 * width/2 rather than dividing by zero. All-identical values still spread
 * across the height's midline rather than collapsing to a flat divide. */
export function scalePoints(values: number[], width: number, height: number, paddingY: number): ChartPoint[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values.map((v, i) => ({
    x: values.length > 1 ? (i / (values.length - 1)) * width : width / 2,
    y: height - paddingY - ((v - min) / range) * (height - paddingY * 2),
  }));
}

export function linePath(points: ChartPoint[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

export function areaPath(points: ChartPoint[], width: number, height: number): string {
  return `${linePath(points)} L${width},${height} L0,${height} Z`;
}

/** A generic date-keyed point — the shape ValueChart.tsx's range slicing
 * needs, satisfied by both Analytics' StitchedPoint (date/total/kind) and
 * Dashboard's own {date, total, kind: "real"} mapping. */
export interface DatedValuePoint {
  date: string;
}

export type ChartRangeKey = "7d" | "30d" | "90d" | "1y" | "all";

/** Same 5 presets for every chart that shows a date-keyed value series —
 * extracted from Analytics' PerformanceChart (the first place this
 * existed) once Dashboard's ValueHistoryChart needed the identical range
 * picker, not a second hand-copied set of options. */
export const CHART_RANGES: { key: ChartRangeKey; label: string; days: number | null }[] = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", days: null },
];

/** Filters a date-ascending point series to the last `days` days (UTC,
 * matching this app's own snapshot_date/date columns, which are plain UTC
 * dates with no time component) — `days: null` ("All") returns every
 * point unfiltered. */
export function sliceToRange<T extends DatedValuePoint>(points: T[], days: number | null): T[] {
  if (days === null || points.length === 0) return points;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  return points.filter((p) => p.date >= cutoffDate);
}

/** A range's change, shown next to the chart's current value. Within one
 * kind of point it's last − first. A range that runs from the estimate
 * (today's holdings at past prices) into real daily snapshots measures two
 * different things, and the step between them — the estimate leaves out
 * every coin without price history — is not a gain or a loss (+$142k on a
 * 30-day view on 2026-09-25 was mostly that step). So the two parts' own
 * returns are chained instead — (1 + r_estimated) × (1 + r_real) − 1, the
 * usual way to link periods — and the dollar change is that return applied
 * to today's value. Null when a part starts at zero (no return to take). */
export function rangeChange(points: readonly { total: number; kind: "real" | "estimated" }[]): { usd: number; pct: number; chained: boolean } | null {
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const seam = points.findIndex((p) => p.kind === "real");
  if (first.kind === "real" || seam === -1) {
    if (first.total === 0) return null;
    return { usd: last.total - first.total, pct: ((last.total - first.total) / first.total) * 100, chained: false };
  }
  const lastEstimated = points[seam - 1];
  const firstReal = points[seam];
  if (first.total === 0 || firstReal.total === 0) return null;
  const r = (lastEstimated.total / first.total) * (last.total / firstReal.total) - 1;
  const start = last.total / (1 + r);
  return { usd: last.total - start, pct: r * 100, chained: true };
}
