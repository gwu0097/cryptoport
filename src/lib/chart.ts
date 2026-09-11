// Pure SVG scale/path math, no React, no DOM — shared by the Dashboard's
// ValueHistoryChart and Analytics' PerformanceChart. Extracted once a
// second component needed the identical min/max scaling + path-building
// logic (CLAUDE.md's stated threshold for pulling shared math out) — only
// the math moved; the two components render genuinely different things
// (a single solid line vs. a dashed-estimate/solid-real split) and stay
// separate.

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
