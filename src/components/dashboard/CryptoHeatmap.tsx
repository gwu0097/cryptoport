"use client";

import { useEffect, useRef } from "react";

// Live-verified against the real embed script (s3.tradingview.com/
// external-embedding/embed-widget-crypto-coins-heatmap.js): this is the
// exact settings shape it reads, with hasTopBar turned on (lets a viewer
// switch grouping/timeframe themselves) and colorTheme pinned to match
// this app's dark UI.
const CONFIG = {
  dataSource: "Crypto",
  blockSize: "market_cap_calc",
  blockColor: "24h_close_change|5",
  colorTheme: "dark",
  locale: "en",
  hasTopBar: true,
  isDataSetEnabled: false,
  isZoomEnabled: true,
  hasSymbolTooltip: true,
  isMonoSize: false,
  width: "100%",
  height: 500,
};

const WIDGET_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-crypto-coins-heatmap.js";

/**
 * TradingView's free "Crypto Coins Heatmap" widget — a pure display embed,
 * not a new data source/metric this app computes (see CLAUDE.md's
 * "Dashboard is a lens" rule: that rule is about new business logic built
 * directly into the Dashboard, which this deliberately isn't — it's a
 * third-party iframe with zero calculation on our side).
 *
 * TradingView's widgets self-mount by reading their own <script> tag's
 * JSON body via `document.currentScript`, so the script element has to be
 * built and appended imperatively rather than declared in JSX — React
 * never executes a `<script>` it renders, and even if it did, the widget
 * needs to find itself as the actual DOM script that's currently running,
 * which only exists once actually inserted.
 */
export function CryptoHeatmap() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.textContent = JSON.stringify(CONFIG);
    container.appendChild(script);

    // The widget script replaces itself with an iframe on load. Clearing
    // the container on cleanup (rather than trying to remove just the
    // script/iframe individually) keeps a React StrictMode dev
    // double-invoke, or any other effect re-run, from ending up with two
    // widgets stacked in the same spot.
    return () => {
      container.innerHTML = "";
    };
  }, []);

  return (
    <>
      {/* Left with no children of our own (no inner ".tradingview-widget-
          container__widget" div): the script self-replaces by appending
          its iframe directly into this element when it finds no such
          child, so there's nothing for React to fight over on a dev
          StrictMode double-invoke of the effect above. */}
      <div className="tradingview-widget-container" ref={containerRef} />
      <p className="mt-2 text-center text-xs text-fg-muted">
        <a
          href="https://www.tradingview.com/"
          rel="noopener nofollow"
          target="_blank"
          className="hover:text-fg"
        >
          Track all markets on TradingView
        </a>
      </p>
    </>
  );
}
