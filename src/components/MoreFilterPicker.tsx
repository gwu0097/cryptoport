"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TokenIcon } from "./TokenIcon";

/**
 * A native `<select>` can't render an icon per option (no markup allowed
 * inside `<option>`) — tried that first, looked exactly as bad as that
 * limitation implies. Custom button + popover list instead, same
 * open-state/outside-click pattern as TagPicker.tsx, so each row can carry
 * its own TokenIcon like the visible cards do. Styled to sit inline as the
 * last card in a 2-row grid (see ChainGroupedHoldings), not as a
 * standalone form control.
 */
export function MoreFilterPicker({
  label,
  options,
  active,
  compact = false,
}: {
  label: string;
  /** `value` is already-formatted ("$1,234 · 3%") — same string the
   * visible cards show under their own name, so a row in this list reads
   * identically to one that happened to fit outside it. */
  options: { key: string; label: string; href: string; icon: string | null; value: string }[];
  /** The option currently selected, if the active filter is one of the
   * overflowed ones — so the picker shows what's actually selected instead
   * of always reverting to its own placeholder. */
  active?: { key: string; label: string; icon: string | null; value: string };
  /** Matches the protocol row's own smaller card styling (see
   * ChainGroupedHoldings' cardClass) — the chain row stays the original
   * size. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full flex-col justify-center gap-0.5 rounded-lg border text-left transition ${
          compact ? "px-2 py-1.5" : "px-3 py-2"
        } ${
          open
            ? "border-accent bg-surface-raised"
            : "border-border bg-surface hover:border-accent/50 hover:bg-surface-raised"
        }`}
      >
        <span className={`flex items-center gap-1.5 truncate font-medium text-fg ${compact ? "text-xs" : "text-sm"}`}>
          {active ? (
            <>
              <TokenIcon ticker={active.label} url={active.icon} size={compact ? "sm" : "md"} />
              <span className="truncate">{active.label}</span>
            </>
          ) : (
            label
          )}
        </span>
        <span className="tabular-nums text-[11px] text-fg-muted">
          {active ? active.value : `${options.length} more…`}
        </span>
      </button>

      {open && (
        <ul className="absolute z-10 mt-1 max-h-64 w-64 overflow-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lg">
          {options.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(o.href);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-border"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <TokenIcon ticker={o.label} url={o.icon} size="sm" />
                  <span className="truncate">{o.label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-xs text-fg-muted">{o.value}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
