"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * A hover/focus-revealed hint bubble — for guidance that's useful but too
 * long/situational to sit permanently under a field (see Field's own `hint`
 * prop for the "short, always-relevant" case; this is for the rest). CSS-only
 * (`group-hover`/`group-focus-within`), no open/close state, no new
 * dependency. `tabIndex={0}` on a `<span>` rather than a real `<button>`:
 * Field wraps its children in a `<label>`, and a `<button>` inside a
 * `<label>` also activates the labelled input on click/Enter, which isn't
 * what this is for.
 */
export function InfoTooltip({ children }: { children: ReactNode }) {
  return (
    <span className="group relative inline-flex" tabIndex={0}>
      <Info className="size-3.5 cursor-help text-fg-muted" aria-hidden="true" />
      <span
        role="tooltip"
        className="invisible absolute bottom-full left-1/2 z-10 mb-1.5 w-64 -translate-x-1/2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs font-normal text-fg-muted opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}
