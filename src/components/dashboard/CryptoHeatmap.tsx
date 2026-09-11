"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Panel } from "../ui/Panel";

// Live-verified against the real embed script (s3.tradingview.com/
// external-embedding/embed-widget-crypto-coins-heatmap.js): this is the
// exact settings shape it reads, with hasTopBar turned on (lets a viewer
// switch grouping/timeframe themselves) and colorTheme pinned to match
// this app's dark UI.
const BASE_CONFIG = {
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
};

// Compact height for the normal in-grid view — roughly matches
// ValueHistoryChart's rendered height where this sits beside it in a
// 2-column row on /dashboard, well short of the widget's own 500px
// default (which by itself pushed the whole page well past one screen's
// worth of scroll for what's whole-market context, not the user's own
// portfolio).
const COMPACT_HEIGHT = 280;

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
 *
 * `height` is a real pixel number, not CSS — the widget's own settings
 * schema wants an explicit height for its container (percent/"auto" are
 * technically accepted by its own validation, but this widget doesn't
 * listen for resize events, so there's no way to get a working
 * "fill whatever space you're given" out of it; a JS-computed pixel
 * number is the one shape known to actually render, since it's what the
 * compact view already ships with). Passing a new value re-mounts the
 * widget (the effect below depends on it) — that's how "expand" resizes
 * an iframe TradingView's own script owns, not ours to resize directly.
 */
function CryptoHeatmap({ height }: { height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.textContent = JSON.stringify({ ...BASE_CONFIG, height });
    container.appendChild(script);

    // The widget script replaces itself with an iframe on load. Clearing
    // the container on cleanup (rather than trying to remove just the
    // script/iframe individually) keeps a React StrictMode dev
    // double-invoke, or any other effect re-run (e.g. `height` changing),
    // from ending up with two widgets stacked in the same spot.
    return () => {
      container.innerHTML = "";
    };
  }, [height]);

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

/**
 * The Panel + expand toggle wrapping CryptoHeatmap — pulled out as its own
 * client component (rather than plumbing expand state through the server-
 * rendered Dashboard page) so /dashboard/page.tsx just renders this with
 * no props, same as every other section on that page.
 *
 * "Expand" is a fixed-position overlay near the full viewport, not the
 * real Fullscreen API — simpler, no permission prompt, and Escape/click-
 * backdrop both close it the same way a real fullscreen would.
 */
export function CryptoHeatmapPanel() {
  const [expanded, setExpanded] = useState(false);
  const [expandedHeight, setExpandedHeight] = useState(COMPACT_HEIGHT);

  useEffect(() => {
    if (!expanded) return;

    // Reading the actual browser viewport (window.innerHeight) — an
    // external system, not state derivable during render — same exception
    // usePersistedState.ts's own read effect documents. Measured once on
    // open rather than tracked live on resize: this widget doesn't
    // respond to being resized after mount anyway (see CryptoHeatmap's
    // doc comment), so a resize listener would have nothing to actually
    // apply mid-session; a stale height until the next open is an
    // acceptable trade for not rebuilding the widget on every resize tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedHeight(Math.max(window.innerHeight - 260, 320));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);

    // Standard modal-open behavior: the page underneath shouldn't scroll
    // while this covers it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  const toggleButton = (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-normal text-fg-muted transition hover:bg-surface-raised hover:text-fg"
    >
      {expanded ? (
        <>
          <Minimize2 className="size-3.5" aria-hidden="true" />
          Collapse
        </>
      ) : (
        <>
          <Maximize2 className="size-3.5" aria-hidden="true" />
          Expand
        </>
      )}
    </button>
  );

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/60"
          onClick={() => setExpanded(false)}
          aria-hidden="true"
        />
      )}
      <Panel
        className={expanded ? "fixed inset-6 z-50 overflow-auto" : undefined}
        title={
          <span className="flex items-center justify-between gap-2">
            Crypto market heatmap
            {toggleButton}
          </span>
        }
        description={expanded ? undefined : "Whole-market daily movement, via TradingView — not your holdings."}
      >
        <CryptoHeatmap height={expanded ? expandedHeight : COMPACT_HEIGHT} />
      </Panel>
    </>
  );
}
