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
    script.text = JSON.stringify({
      autosize: true,
      symbol: guessTradingViewSymbol(baseTicker),
      compareSymbols: [{ symbol: guessTradingViewSymbol(compareTicker), position: "SameScale" }],
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
  }, [baseTicker, compareTicker]);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="tradingview-widget-container" ref={containerRef} style={{ height }} />
      <p className="border-t border-border bg-surface-raised px-3 py-1.5 text-[11px] text-fg-muted">
        Best-guess Binance listing for each ticker — use the chart&rsquo;s own symbol search (top-left) to correct
        either side if it&rsquo;s wrong or unlisted.
      </p>
    </div>
  );
}
