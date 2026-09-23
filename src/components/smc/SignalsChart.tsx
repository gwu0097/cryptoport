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
import type { Candle } from "@/lib/smc/engine";
import type { OverlayLine, SignalMark } from "@/lib/signals/view";
import type { NextTrigger } from "@/lib/signals/triggers";
import { formatTimeInZone, formatAxisInZone } from "@/lib/smc/time";
import { useTimeZone } from "@/components/timezone/TimeZoneProvider";

const BULL = "#26a65b";
const BEAR = "#e05a4f";
// How many chart candles are in view on load (the full history is still on
// the chart — scroll/zoom out to see it; indicators are computed over all of it).
const INITIAL_VISIBLE = 180;

const LINE_STYLE = { solid: LineStyle.Solid, dotted: LineStyle.Dotted, dashed: LineStyle.Dashed } as const;

/**
 * TradingView's open-source Lightweight Charts, drawn with this app's own
 * indicator ports (the free TradingView embed widget can't run a private
 * Pine script). Candles + the selected indicator's overlay lines (SMC: its
 * Close/Open Series ribbon, a step line colored by state) + Buy/Sell labels +
 * the forming bar's/block's exact trigger price, when one exists.
 */
export function SignalsChart({
  candles,
  overlays,
  signals,
  trigger,
  closeUnit,
}: {
  candles: Candle[];
  overlays: OverlayLine[];
  signals: SignalMark[];
  trigger: NextTrigger | null;
  closeUnit: string;
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

    for (const o of overlays) {
      const s = chart.addSeries(LineSeries, {
        title: o.title,
        color: o.color,
        lineWidth: o.step ? 2 : 1,
        lineType: o.step ? 1 : 0,
        lineStyle: LINE_STYLE[o.style],
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(o.points.map((p) => (p.color ? { time: t(p.time), value: p.value, color: p.color } : { time: t(p.time), value: p.value })));
    }

    const markers: SeriesMarker<Time>[] = signals.map((m) => ({
      time: t(m.barTime),
      position: m.side === "BUY" ? "belowBar" : "aboveBar",
      shape: m.side === "BUY" ? "arrowUp" : "arrowDown",
      color: m.side === "BUY" ? BULL : BEAR,
      text: m.side === "BUY" ? "Buy" : "Sell",
    }));
    createSeriesMarkers(candleSeries, markers);

    if (trigger?.kind === "price") {
      const color = trigger.side === "BUY" ? BULL : BEAR;
      candleSeries.createPriceLine({
        price: trigger.price,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${trigger.side} if ${closeUnit} closes ${trigger.condition}`,
      });
      if (trigger.floor !== null) {
        candleSeries.createPriceLine({
          price: trigger.floor,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "…and above (SMA 200)",
        });
      }
    }

    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - INITIAL_VISIBLE), to: candles.length + 3 });
    return () => chart.remove();
  }, [candles, overlays, signals, trigger, closeUnit, tz]);

  return <div ref={container} className="h-[480px] w-full" />;
}
