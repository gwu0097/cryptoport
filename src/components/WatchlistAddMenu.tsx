"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Check } from "lucide-react";
import type { WatchlistSummary } from "@/lib/queries";
import { addWatchlistItem, addWatchlistItems, type AddableCoin } from "@/app/(app)/watchlist/actions";

/**
 * "Add to watchlist" for one or several coins at once — reported directly:
 * Trend Finder's peer tables had no way to save a result for later without
 * leaving the page and re-searching it on /watchlist. Button + portal
 * dropdown, same pattern as TagPicker.tsx's own combobox (outside-click
 * close checking both the trigger and the portaled menu, position tracked
 * via getBoundingClientRect and recomputed on scroll/resize) — duplicated
 * rather than extracted into a shared hook, since this is only the second
 * occurrence of the pattern; see CLAUDE.md's own "two copies is fine,
 * three is the extraction trigger" convention.
 *
 * `watchlists`: `null` means the viewer isn't signed in (the menu still
 * opens, but offers a login link instead of a picker — better than hiding
 * the feature entirely, which would look like Trend Finder just doesn't
 * have it). An empty array means signed in with zero watchlists yet — the
 * menu offers a link to create one rather than a picker with nothing in
 * it.
 */
export function WatchlistAddMenu({
  coins,
  watchlists,
  trigger,
  triggerClassName = "",
  triggerLabel,
  disabled = false,
  align = "right",
  onAdded,
}: {
  coins: AddableCoin[];
  watchlists: WatchlistSummary[] | null;
  /** Plain content (an icon, a label) — never another `<button>`/`<Button>`
   * element, which would nest an interactive element inside the one this
   * component already renders around it. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Accessible name for an icon-only trigger — the icon itself is always
   * `aria-hidden`, so a screen reader has nothing to announce without
   * this. Omit when `trigger` already carries its own visible text (the
   * bulk "Add to watchlist" button). */
  triggerLabel?: string;
  disabled?: boolean;
  align?: "left" | "right";
  onAdded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [addedTo, setAddedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; right: number } | null>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Same overflow-clipping escape as TagPicker.tsx — a table row's own
  // `overflow-x-auto` wrapper (TrendPeerTable) forces overflow-y to
  // compute as a clipping "auto" too, per the CSS spec quirk documented
  // there, so a plain `absolute` dropdown on a row near the bottom of a
  // long table would get cut off.
  useLayoutEffect(() => {
    if (!open) return;
    function updateRect() {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom, left: r.left, right: window.innerWidth - r.right });
    }
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    setError(null);
    setAddedTo(null);
    setOpen((v) => !v);
  }

  async function addTo(watchlistId: string, watchlistName: string) {
    setPendingId(watchlistId);
    setError(null);
    try {
      if (coins.length === 1) await addWatchlistItem(watchlistId, coins[0]);
      else await addWatchlistItems(watchlistId, coins);
      setAddedTo(watchlistName);
      onAdded?.();
      // Closes on its own after a beat so the confirmation is actually
      // readable — an instant close read as "did that even work?" when
      // this was first built.
      setTimeout(() => setOpen(false), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={triggerLabel}
        className={triggerClassName}
      >
        {trigger}
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ top: rect.top, ...(align === "right" ? { right: rect.right } : { left: rect.left }) }}
            className="fixed z-50 mt-1 w-56 rounded-lg border border-border bg-surface-raised py-1 shadow-lg"
          >
            {watchlists === null ? (
              <div className="px-3 py-2 text-sm text-fg-muted">
                <Link href="/login" className="text-accent hover:underline">
                  Log in
                </Link>{" "}
                to save to a watchlist.
              </div>
            ) : watchlists.length === 0 ? (
              <div className="px-3 py-2 text-sm text-fg-muted">
                No watchlists yet —{" "}
                <Link href="/watchlist" className="text-accent hover:underline">
                  create one
                </Link>
                .
              </div>
            ) : (
              watchlists.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => addTo(w.id, w.name)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-border disabled:opacity-60"
                >
                  <span className="truncate">{w.name}</span>
                  {addedTo === w.name ? (
                    <Check className="size-3.5 shrink-0 text-positive" aria-hidden="true" />
                  ) : pendingId === w.id ? (
                    <span className="shrink-0 text-xs text-fg-muted">Adding…</span>
                  ) : (
                    <span className="shrink-0 text-xs text-fg-muted">{w.itemCount}</span>
                  )}
                </button>
              ))
            )}
            {error && <p className="px-3 py-1.5 text-xs text-negative">{error}</p>}
          </div>,
          document.body,
        )}
    </div>
  );
}
