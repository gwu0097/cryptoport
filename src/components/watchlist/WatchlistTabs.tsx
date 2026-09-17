"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Copy, Check, X } from "lucide-react";
import type { WatchlistSummary } from "@/lib/queries";
import { createWatchlist, renameWatchlist, cloneWatchlist, deleteWatchlist } from "@/app/(app)/watchlist/actions";
import { inputClass } from "../ui/Field";
import { Button } from "../ui/Button";
import { SubmitButton } from "../ui/SubmitButton";
import { ConfirmDeleteButton } from "../ui/ConfirmDeleteButton";

function NewWatchlistForm() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden="true" />
        New watchlist
      </Button>
    );
  }
  return (
    <form action={createWatchlist} className="flex items-center gap-2">
      <input
        name="name"
        type="text"
        autoFocus
        required
        placeholder="Watchlist name"
        className={`${inputClass} w-40 py-1.5`}
      />
      <SubmitButton size="sm" pendingLabel="Creating…">
        Create
      </SubmitButton>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Cancel"
        className="rounded p-1 text-fg-muted hover:text-fg"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </form>
  );
}

function RenameForm({ watchlist, onDone }: { watchlist: WatchlistSummary; onDone: () => void }) {
  return (
    <form
      action={async (formData: FormData) => {
        await renameWatchlist(watchlist.id, formData);
        onDone();
      }}
      className="flex items-center gap-2"
    >
      <input
        name="name"
        type="text"
        autoFocus
        required
        defaultValue={watchlist.name}
        className={`${inputClass} w-40 py-1.5`}
      />
      <SubmitButton size="sm" pendingLabel="Saving…" variant="secondary">
        <Check className="size-3.5" aria-hidden="true" />
      </SubmitButton>
      <button type="button" onClick={onDone} aria-label="Cancel" className="rounded p-1 text-fg-muted hover:text-fg">
        <X className="size-4" aria-hidden="true" />
      </button>
    </form>
  );
}

/** Link-based tab row (URL is the source of truth for which list is
 * selected, same philosophy as CheckboxLink) plus New/Rename/Clone/Delete
 * for whichever list is currently selected — those four are the only
 * pieces that need client state (an inline text input, a confirm dialog),
 * so the pill row itself stays plain <Link>s rather than client-side tab
 * switching. */
export function WatchlistTabs({
  watchlists,
  selected,
}: {
  watchlists: WatchlistSummary[];
  selected: WatchlistSummary;
}) {
  const [renaming, setRenaming] = useState(false);

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {watchlists.map((w) => (
          <Link
            key={w.id}
            href={`/watchlist?list=${w.id}`}
            className={
              "rounded-lg px-3 py-1.5 text-sm transition " +
              (w.id === selected.id
                ? "bg-accent text-accent-fg"
                : "border border-border text-fg-muted hover:bg-surface-raised hover:text-fg")
            }
          >
            {w.name} <span className="opacity-70">({w.itemCount})</span>
          </Link>
        ))}
        <NewWatchlistForm />
      </div>

      <div className="flex items-center gap-2">
        {renaming ? (
          <RenameForm watchlist={selected} onDone={() => setRenaming(false)} />
        ) : (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => setRenaming(true)}>
              <Pencil className="size-3.5" aria-hidden="true" />
              Rename
            </Button>
            <form action={cloneWatchlist.bind(null, selected.id)}>
              <SubmitButton variant="secondary" size="sm" pendingLabel="Cloning…">
                <Copy className="size-3.5" aria-hidden="true" />
                Clone
              </SubmitButton>
            </form>
            <form action={deleteWatchlist.bind(null, selected.id)}>
              <ConfirmDeleteButton confirmMessage={`Delete "${selected.name}"? This removes its ${selected.itemCount} tracked coin${selected.itemCount === 1 ? "" : "s"}.`}>
                Delete
              </ConfirmDeleteButton>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
