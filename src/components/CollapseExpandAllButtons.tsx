"use client";

/**
 * Expands/collapses every native <details> inside a container in one click
 * — reported directly: with many chains (each its own <details>) and, on
 * top of that, many nested DeFi protocol sub-groups (each their own
 * <details>, all default-open — see ChainGroupedHoldings.tsx), a wallet
 * with real breadth across chains/protocols means scrolling through
 * everything just to see the per-chain/per-protocol totals. Plain DOM
 * manipulation on click, not React state — these are native, uncontrolled
 * <details> elements (no client JS needed for the default expand/collapse
 * behavior itself, only for this bulk-toggle convenience), and a user can
 * already open/close any individual one by hand; querying the container at
 * click time instead of tracking state means this never drifts out of sync
 * with whatever's actually open.
 */
export function CollapseExpandAllButtons({ containerId }: { containerId: string }) {
  function setAll(open: boolean) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll("details").forEach((d) => {
      d.open = open;
    });
  }

  return (
    <div className="flex gap-2 text-xs">
      <button
        type="button"
        onClick={() => setAll(false)}
        className="text-fg-muted underline-offset-2 transition hover:text-fg hover:underline"
      >
        Collapse all
      </button>
      <span className="text-fg-muted/50">·</span>
      <button
        type="button"
        onClick={() => setAll(true)}
        className="text-fg-muted underline-offset-2 transition hover:text-fg hover:underline"
      >
        Expand all
      </button>
    </div>
  );
}
