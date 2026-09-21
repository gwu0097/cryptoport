"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { inputClass } from "./ui/Field";

/**
 * Multi-select tag input: existing tags picked from a dropdown, or a new
 * one created on the spot by typing a name nothing matches — the same
 * "reuse or create inline" behavior the old single-tag free-text field had
 * (see resolveTagId's doc comment in wallets/actions.ts), just multi-select.
 * No multi-select primitive existed anywhere in ui/ to build this on top of
 * (checked before writing this), so it's a from-scratch combobox.
 *
 * Selected tags are submitted as repeated hidden `name="tags"` inputs — the
 * server reads them via `formData.getAll("tags")` — rather than a single
 * comma-joined string, so a tag name containing a comma can't corrupt the
 * list.
 */
export function TagPicker({
  name = "tags",
  allTags,
  defaultSelected = [],
}: {
  name?: string;
  allTags: string[];
  defaultSelected?: string[];
}) {
  const [selected, setSelected] = useState<string[]>(defaultSelected);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      // The dropdown now renders through a portal (see the effect below),
      // so it's no longer a DOM descendant of containerRef — checking only
      // containerRef here would treat every click on a dropdown option as
      // an "outside" click and close the list right after each selection.
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // EditWalletModal renders this inside Dialog's own `overflow-y-auto`
  // scroll container (see Dialog.tsx's doc comment — that scroll cap is
  // load-bearing for a different real bug, not something to remove here).
  // A plain `absolute` dropdown is clipped by that ancestor whenever it
  // pokes past the dialog's current box — reported directly, with a
  // screenshot showing the tag list cut off mid-item at the dialog's
  // rounded corner instead of fully visible or scrollable-to. Rendering it
  // through a portal into document.body, positioned in viewport
  // coordinates from the input's own bounding rect, escapes every
  // ancestor's overflow clipping (the same reason Radix/Popper-style
  // libraries portal their popovers) rather than papering over this one
  // report by just making the dialog taller, which wouldn't help a wallet
  // with more tags or a shorter viewport next time.
  useLayoutEffect(() => {
    if (!open) return;
    function updateRect() {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDropdownRect({ top: r.bottom, left: r.left, width: r.width });
    }
    updateRect();
    // capture:true so this also fires for scrolling inside Dialog's own
    // scroll container, not just window-level scrolling.
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  function addTag(tagName: string) {
    const trimmed = tagName.trim();
    if (!trimmed) return;
    setSelected((prev) => (prev.some((t) => t.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed]));
    setQuery("");
  }

  function removeTag(tagName: string) {
    setSelected((prev) => prev.filter((t) => t !== tagName));
  }

  const trimmedQuery = query.trim();
  const filtered = allTags.filter(
    (t) =>
      t.toLowerCase().includes(trimmedQuery.toLowerCase()) &&
      !selected.some((s) => s.toLowerCase() === t.toLowerCase()),
  );
  const exactMatch = allTags.some((t) => t.toLowerCase() === trimmedQuery.toLowerCase());
  const showDropdown = open && (filtered.length > 0 || (trimmedQuery !== "" && !exactMatch));

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`${inputClass} flex flex-wrap items-center gap-1.5`}
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs text-fg"
          >
            {t}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              // Both pointerdown (immediate, reliable on touch — see the
              // dropdown options below for why) and click (keyboard
              // activation via Tab+Enter/Space dispatches click, never
              // pointerdown, so this stays reachable without a pointer at
              // all) — removeTag is idempotent, so a normal mouse click
              // firing both handlers is harmless, not a double-remove.
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                removeTag(t);
              }}
              onClick={(e) => {
                e.stopPropagation();
                removeTag(t);
              }}
              className="text-fg-muted hover:text-fg"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (trimmedQuery !== "") addTag(trimmedQuery);
              else if (filtered[0]) addTag(filtered[0]);
            } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
              removeTag(selected[selected.length - 1]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={selected.length === 0 ? "Add a tag…" : ""}
          className="min-w-24 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
        />
      </div>

      {showDropdown &&
        dropdownRect &&
        createPortal(
          <ul
            ref={dropdownRef}
            style={{ top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width }}
            className="fixed z-50 mt-1 max-h-48 overflow-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lg"
          >
            {filtered.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  // Both pointerdown and click — real bug, reported
                  // directly: selecting a tag "didn't stick" on a mobile
                  // browser. The text input above still had focus while
                  // this button was tapped; on touch devices that first tap
                  // can just blur the input (dismissing the keyboard) and
                  // never actually fire a click on the button at all — a
                  // well-known mobile Safari/Chrome quirk, not specific to
                  // this component. preventDefault on pointerdown stops
                  // that default blur-shift behavior so the tap registers
                  // immediately and reliably; click stays as the fallback
                  // for keyboard activation (Tab+Enter/Space dispatches
                  // click, never pointerdown). addTag is idempotent, so a
                  // normal mouse click firing both is harmless.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    addTag(t);
                  }}
                  onClick={() => addTag(t)}
                  className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-border"
                >
                  {t}
                </button>
              </li>
            ))}
            {trimmedQuery !== "" && !exactMatch && (
              <li>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    addTag(trimmedQuery);
                  }}
                  onClick={() => addTag(trimmedQuery)}
                  className="block w-full px-3 py-1.5 text-left text-sm text-accent hover:bg-border"
                >
                  Create &ldquo;{trimmedQuery}&rdquo;
                </button>
              </li>
            )}
          </ul>,
          document.body,
        )}

      {selected.map((t) => (
        <input key={t} type="hidden" name={name} value={t} />
      ))}
    </div>
  );
}
