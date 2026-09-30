"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, X } from "lucide-react";

/**
 * A name with its rename right beside it (owner 2026-09-30: no Edit button
 * or dialog just to change a name): the pencil turns the name into a field
 * in place — Enter or ✓ saves, Esc or ✕ cancels. `onSave` returns an error
 * to show, or null when saved (its action revalidates the page).
 * `children` is how the name shows when not editing (default: the name).
 */
export function InlineName({
  name,
  onSave,
  label = "Rename",
  maxLength = 80,
  inputClassName = "text-sm",
  children,
}: {
  name: string;
  onSave: (name: string) => Promise<string | null>;
  label?: string;
  maxLength?: number;
  inputClassName?: string;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {children ?? name}
        <button
          type="button"
          onClick={() => {
            setError(null);
            setEditing(true);
          }}
          aria-label={label}
          title={label}
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    );
  }

  return (
    <form
      action={(form) =>
        start(async () => {
          const next = String(form.get("name") ?? "").trim();
          if (!next || next === name) return setEditing(false);
          const err = await onSave(next);
          if (err) setError(err);
          else setEditing(false);
        })
      }
      className="inline-flex flex-wrap items-center gap-1"
    >
      <input
        name="name"
        autoFocus
        required
        maxLength={maxLength}
        defaultValue={name}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        disabled={pending}
        className={`min-w-0 rounded-md border border-border bg-bg px-2 py-0.5 text-fg outline-none focus:border-accent ${inputClassName}`}
        style={{ width: `${Math.max(8, Math.min(40, name.length + 2))}ch` }}
      />
      <button type="submit" disabled={pending} aria-label="Save" className="rounded p-1 text-fg-muted hover:text-positive disabled:opacity-50">
        <Check className="size-4" aria-hidden="true" />
      </button>
      <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="rounded p-1 text-fg-muted hover:text-fg">
        <X className="size-4" aria-hidden="true" />
      </button>
      {error && <span className="text-xs font-normal text-negative">{error}</span>}
    </form>
  );
}
