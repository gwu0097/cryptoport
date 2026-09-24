"use client";

import { useEffect, useRef } from "react";
import { createChart, LineSeries, type Time } from "lightweight-charts";
import { formatCompactUsd } from "@/lib/format";

export interface FundamentalsPoint {
  date: string; // YYYY-MM-DD (UTC day of the stored snapshot)
  fees30d: number | null;
  revenue30d: number | null;
  holdersRevenue30d: number | null;
  isBackfilled: boolean;
}

// Each series' live color, and a faded one for backfilled days (rebuilt from
// DefiLlama history rather than captured by the daily job on the day).
const SERIES = [
  { key: "fees30d", title: "Fees (30d)", live: "#38bdf8", backfilled: "rgba(56,189,248,0.45)" },
  { key: "revenue30d", title: "Revenue (30d)", live: "#26a65b", backfilled: "rgba(38,166,91,0.45)" },
  { key: "holdersRevenue30d", title: "Holders revenue (30d)", live: "#f59e0b", backfilled: "rgba(245,158,11,0.45)" },
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis label for a date-string ("YYYY-MM-DD") time: the year on year ticks,
 * "Mar 2" otherwise — computed from the string itself, so no timezone shift. */
function dayTick(time: Time, tickType: number): string {
  // Date-string times may come back as the string or as a BusinessDay object.
  const [y, m, d] =
    typeof time === "object" && time !== null && "year" in time ? [time.year, time.month, time.day] : String(time).split("-").map(Number);
  if (tickType === 0) return String(y); // TickMarkType.Year
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * Stored rolling-30-day fees / revenue / holders revenue, one point per UTC
 * day. Times are date strings (lightweight-charts "business days"), so a UTC
 * day is labeled as that day in every timezone — no Sep 1 UTC turning into
 * "Aug 31" on the axis. A day with no value is a gap, never a 0.
 */
export function FundamentalsHistoryChart({ points }: { points: FundamentalsPoint[] }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#9ca3af", attributionLogo: true },
      grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.2)",
        // The library's default labels a day tick with a bare day number ("2").
        tickMarkFormatter: (time: Time, tickType: number) => dayTick(time, tickType),
      },
      localization: { priceFormatter: (v: number) => formatCompactUsd(v) },
      crosshair: { mode: 0 },
    });
    for (const s of SERIES) {
      const series = chart.addSeries(LineSeries, { title: s.title, color: s.live, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      series.setData(
        points.map((p) => {
          const v = p[s.key];
          return v === null
            ? { time: p.date as Time } // whitespace point: a gap, not a 0
            : { time: p.date as Time, value: v, color: p.isBackfilled ? s.backfilled : s.live };
        }),
      );
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  return <div ref={container} className="h-[320px] w-full" />;
}
