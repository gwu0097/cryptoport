"use client";

import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Panel } from "../ui/Panel";

// Compact height for the normal in-grid view — roughly matches
// ValueHistoryChart's rendered height where this sits beside it in a
// 2-column row on /dashboard.
const COMPACT_HEIGHT = 280;

// Coin360's documented embed widget (coin360.com/about/widgets) — a plain
// iframe, unlike the TradingView heatmap this replaced (which needed a
// self-mounting <script> that reads its own JSON body, since it wasn't a
// real iframe until that script ran). Switched because TradingView's
// crypto heatmap only sizes tiles by market cap with no sector grouping
// (verified against its own settings schema: unlike its stock/ETF
// heatmaps, the crypto one has no "grouping" option at all), so BTC/ETH
// visually swallow everything else. Coin360's own site groups coins into
// real sector blocks instead — live-verified against coin360.com's
// homepage: DeFi, Gaming, Infrastructure & Platform, Layer 1, Memes,
// NFTs & Entertainment, Stablecoins & Financial Instruments, etc. Whether
// this specific smaller embeddable widget (a separate page from their
// main site) keeps that same category breakdown, rather than a
// simplified variant, is NOT independently confirmed — first real load
// is the check.
const WIDGET_SRC = "https://coin360.com/widget/map?utm_source=embed_map";

/**
 * A pure display embed — no calculation of our own (see CLAUDE.md's
 * "Dashboard is a lens" rule: this isn't a new data source/metric built
 * into the Dashboard, just a third-party iframe).
 *
 * A real iframe (unlike the TradingView widget this replaced), so
 * resizing for the expand toggle below is just a height prop — no
 * rebuild/remount needed the way TradingView's self-mounting script
 * required.
 */
function CryptoHeatmap({ height }: { height: number }) {
  return (
    <>
      <iframe
        src={WIDGET_SRC}
        title="Coin360.com: Cryptocurrency Market State"
        width="100%"
        height={height}
        style={{ height }}
        loading="lazy"
        className="w-full rounded-lg border-0"
      />
      <p className="mt-2 text-center text-xs text-fg-muted">
        <a href="https://coin360.com/" rel="noopener nofollow" target="_blank" className="hover:text-fg">
          Market data via Coin360
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
    // open rather than tracked live on resize — a stale height until the
    // next open is an acceptable trade for not adding a resize listener
    // for what's a rare, deliberate interaction.
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
        description={expanded ? undefined : "Whole-market daily movement, via Coin360 — not your holdings."}
      >
        <CryptoHeatmap height={expanded ? expandedHeight : COMPACT_HEIGHT} />
      </Panel>
    </>
  );
}
