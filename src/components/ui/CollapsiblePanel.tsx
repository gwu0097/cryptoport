"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Panel } from "./Panel";
import { usePersistedState } from "../usePersistedState";

/**
 * A Panel whose title opens and closes it, remembered per browser
 * (`storageKey`). Collapsed, it shows `summary` beside the title (the
 * section's headline numbers) and keeps `actions` reachable; the toolbar
 * and content only when open. Controlled with `open`/`onOpenChange` when
 * the parent needs the state (e.g. to stop a hidden section listening).
 */
export function CollapsiblePanel({
  storageKey,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  title,
  summary,
  toolbar,
  actions,
  description,
  density = "compact",
  className = "",
  children,
}: {
  storageKey: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  summary?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  density?: "normal" | "compact";
  className?: string;
  children: ReactNode;
}) {
  const [stored, setStored] = usePersistedState<boolean>(storageKey, defaultOpen);
  const open = controlledOpen ?? stored;
  const setOpen = (v: boolean) => {
    setStored(v);
    onOpenChange?.(v);
  };
  return (
    <Panel
      density={density}
      className={className}
      title={
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1.5 text-left">
          <ChevronRight className={`size-4 shrink-0 text-fg-muted transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
          <span>{title}</span>
          {!open && summary && <span className="ml-2 text-sm font-normal tabular-nums text-fg-muted">{summary}</span>}
        </button>
      }
      description={open ? description : undefined}
      toolbar={open ? toolbar : undefined}
      actions={actions}
    >
      {open ? children : null}
    </Panel>
  );
}
