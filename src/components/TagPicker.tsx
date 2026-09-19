"use client";

import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

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

      {showDropdown && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lg">
          {filtered.map((t) => (
            <li key={t}>
              <button
                type="button"
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
                onClick={() => addTag(trimmedQuery)}
                className="block w-full px-3 py-1.5 text-left text-sm text-accent hover:bg-border"
              >
                Create &ldquo;{trimmedQuery}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}

      {selected.map((t) => (
        <input key={t} type="hidden" name={name} value={t} />
      ))}
    </div>
  );
}
