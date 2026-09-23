"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { Candle, RibbonPoint, Flip, Trigger } from "@/lib/smc/engine";
import { formatTimeInZone, formatAxisInZone } from "@/lib/smc/time";
import { useTimeZone } from "@/components/timezone/TimeZoneProvider";

const BULL = "#26a65b";
const BEAR = "#e05a4f";
// How many chart candles are in view on load (the full history is still on
// the chart — scroll/zoom out to see it; the RMA is computed over all of it).
const INITIAL_VISIBLE = 180;

/**
 * TradingView's open-source Lightweight Charts, drawn with this app's own
 * port of the user's SMC indicator (the free TradingView embed widget can't
 * run a private Pine script). Candles + the Close/Open Series ribbon ("the
 * baseline", colored by state; a step line because with Delay = 1 it only
 * changes when a block completes) + Buy/Sell labels + the forming block's
 * trigger price.
 */
export function SmcChart({
  candles,
  ribbon,
  flips,
  trigger,
  blockLabel,
}: {
  candles: Candle[];
  ribbon: RibbonPoint[];
  flips: Flip[];
  trigger: Trigger | null;
  blockLabel: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const tz = useTimeZone();

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#9ca3af", attributionLogo: true },
      grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)" },
      // The user's timezone on the axis and crosshair (the library defaults to UTC).
      localization: { timeFormatter: (time: Time) => formatTimeInZone(time as number, tz) },
      timeScale: {
        borderColor: "rgba(148,163,184,0.2)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatAxisInZone(time as number, tz),
      },
      crosshair: { mode: 0 },
    });

    const t = (sec: number) => sec as UTCTimestamp;
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: BULL,
      downColor: BEAR,
      borderVisible: false,
      wickUpColor: BULL,
      wickDownColor: BEAR,
    });
    candleSeries.setData(candles.map((c) => ({ time: t(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));

    const lineOpts = { lineWidth: 2 as const, lineType: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const closeLine = chart.addSeries(LineSeries, { ...lineOpts, title: "Close Series" });
    const openLine = chart.addSeries(LineSeries, { ...lineOpts, title: "Open Series", lineStyle: LineStyle.Dotted });
    closeLine.setData(ribbon.map((p) => ({ time: t(p.time), value: p.close, color: p.bull ? BULL : BEAR })));
    openLine.setData(ribbon.map((p) => ({ time: t(p.time), value: p.open, color: p.bull ? BULL : BEAR })));

    const markers: SeriesMarker<Time>[] = flips.map((f) => ({
      time: t(f.time),
      position: f.side === "BUY" ? "belowBar" : "aboveBar",
      shape: f.side === "BUY" ? "arrowUp" : "arrowDown",
      color: f.side === "BUY" ? BULL : BEAR,
      text: f.side === "BUY" ? "Buy" : "Sell",
    }));
    createSeriesMarkers(candleSeries, markers);

    if (trigger) {
      candleSeries.createPriceLine({
        price: trigger.price,
        color: trigger.flipTo === "BUY" ? BULL : BEAR,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${trigger.flipTo} if ${blockLabel} closes ${trigger.flipIfClose}`,
      });
    }

    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - INITIAL_VISIBLE), to: candles.length + 3 });
    return () => chart.remove();
  }, [candles, ribbon, flips, trigger, blockLabel, tz]);

  return <div ref={container} className="h-[480px] w-full" />;
}
