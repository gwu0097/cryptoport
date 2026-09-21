"use client";

import { useEffect, useRef } from "react";
import { guessTradingViewSymbol } from "@/lib/tradingViewSymbol";

/**
 * Embeds TradingView's free, keyless Advanced Chart widget with a compare
 * overlay — the two tickers' price action normalized to % change on one
 * chart, so you can see whether a "lagging" peer actually moved early or
 * is genuinely behind, rather than trusting a single correlation/24h-change
 * number. Symbols are a best guess (see guessTradingViewSymbol's own doc
 * comment on why, not an assumption) — `allow_symbol_change` in the widget
 * config below lets either side be corrected by hand directly inside the
 * chart if the guess is wrong or unlisted on Binance.
 *
 * The widget reads its JSON config once, at the moment its script tag is
 * injected — it doesn't react to prop changes on its own the way a normal
 * React component would. So this rebuilds the container's DOM from scratch
 * (and re-injects a fresh script) inside an effect keyed on the ticker
 * pair, rather than trying to imperatively reconfigure a live widget
 * instance, which TradingView's embed script doesn't expose a way to do.
 */
export function TradingViewCompareChart({
  baseTicker,
  compareTicker,
  height = 600,
}: {
  baseTicker: string;
  compareTicker: string;
  /** Reported directly: the old 420px default was too cramped to read
   * price action clearly, especially with two overlaid lines' legends. */
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";

    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    widgetDiv.style.height = "100%";
    widgetDiv.style.width = "100%";
    container.appendChild(widgetDiv);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;

    const compareSymbols: { symbol: string; position: string; linestyle?: number }[] = [
      { symbol: guessTradingViewSymbol(compareTicker), position: "SameScale" },
    ];
    // BTC as a always-on baseline, dashed to read as "the market," not a
    // third thing being compared — skipped when either side already IS
    // BTC, since overlaying it against itself is meaningless. linestyle:2
    // (dashed) is a best-effort attempt: TradingView's per-series line-
    // style override is documented for the full Charting Library's widget
    // constructor, not confirmed for this free embed widget's compare
    // config — if the embed silently ignores the field, BTC still shows as
    // a solid third line, which is still a real, useful baseline.
    if (baseTicker.toUpperCase() !== "BTC" && compareTicker.toUpperCase() !== "BTC") {
      compareSymbols.push({ symbol: guessTradingViewSymbol("BTC"), position: "SameScale", linestyle: 2 });
    }

    // autosize:true was reported (with a screenshot) to render a cramped
    // chart even though the outer container genuinely had height:600px —
    // confirmed live in the deployed HTML, so this wasn't a CSS mistake on
    // this component's own side, it's a real autosize-vs-nested-container
    // quirk. Passing an explicit width/height directly in the widget's own
    // config (what TradingView documents for a fixed-size embed, as
    // opposed to "fill whatever the container computes to") is the
    // reliable fix.
    script.text = JSON.stringify({
      autosize: false,
      width: "100%",
      height,
      symbol: guessTradingViewSymbol(baseTicker),
      compareSymbols,
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      hide_top_toolbar: false,
      hide_legend: false,
    });
    container.appendChild(script);
  }, [baseTicker, compareTicker, height]);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="tradingview-widget-container" ref={containerRef} style={{ height }} />
      <p className="border-t border-border bg-surface-raised px-3 py-1.5 text-[11px] text-fg-muted">
        Best-guess Binance listing for each ticker — use the chart&rsquo;s own symbol search (top-left) to correct
        either side if it&rsquo;s wrong or unlisted. BTC is overlaid (dashed, if the chart honors that) as a market
        baseline.
      </p>
    </div>
  );
}
