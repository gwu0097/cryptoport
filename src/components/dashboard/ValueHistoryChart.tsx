import type { PortfolioHistoryPoint } from "@/lib/queries";
import { formatUsdSigned, formatPercent } from "@/lib/format";
import { scalePoints, linePath, areaPath } from "@/lib/chart";
import { Panel } from "../ui/Panel";

const WIDTH = 600;
const HEIGHT = 160;
const PADDING_Y = 12;

function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Hand-rolled SVG rather than a charting dependency — this codebase has
 * none today, and portfolio_snapshots only accumulates one row per day
 * (see snapshots.ts), so this will only ever have a handful of points for
 * the first few weeks. Revisit a real library later if this grows into
 * something that wants tooltips/zoom once there's months of data.
 */
export function ValueHistoryChart({ points }: { points: PortfolioHistoryPoint[] }) {
  if (points.length < 2) {
    return (
      <Panel title="Value history">
        <p className="text-sm text-fg-muted">
          Building your value history — check back in a few days. A snapshot is captured once a day.
        </p>
      </Panel>
    );
  }

  const coords = scalePoints(
    points.map((p) => p.total),
    WIDTH,
    HEIGHT,
    PADDING_Y,
  );
  const line = linePath(coords);
  const area = areaPath(coords, WIDTH, HEIGHT);

  const first = points[0].total;
  const last = points[points.length - 1].total;
  const deltaUsd = last - first;
  const deltaPct = first !== 0 ? (deltaUsd / first) * 100 : 0;
  const trendClass = deltaUsd >= 0 ? "text-positive" : "text-negative";

  return (
    <Panel title="Value history">
      <div className={trendClass}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-40 w-full"
          role="img"
          aria-label="Portfolio value over time"
        >
          <path d={area} fill="currentColor" fillOpacity={0.12} stroke="none" />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
        <span>{shortDate(points[0].date)}</span>
        <span className={`text-sm font-medium tabular-nums ${trendClass}`}>
          {formatUsdSigned(deltaUsd)} ({formatPercent(deltaPct)})
        </span>
        <span>{shortDate(points[points.length - 1].date)}</span>
      </div>
    </Panel>
  );
}
