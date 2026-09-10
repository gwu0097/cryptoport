"use client";

import { forwardRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Shared modal shell for every popup form in the app (edit wallet, add
 * holding, ...) — one place for the details that are easy to get subtly
 * wrong if each modal hand-rolls its own: `fixed inset-0 m-auto` is what
 * actually centers a native <dialog>. The browser centers it by default,
 * but Tailwind's Preflight resets margin to 0 globally, which silently
 * strips that default centering (`margin: auto`) and left every popup
 * pinned to the top-left instead — this makes it explicit instead of
 * relying on a UA default Preflight quietly undoes.
 */
export const Dialog = forwardRef<HTMLDialogElement, { title: string; children: ReactNode }>(
  function Dialog({ title, children }, ref) {
    return (
      <dialog
        ref={ref}
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="fixed inset-0 m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <button
            type="button"
            onClick={(e) => e.currentTarget.closest("dialog")?.close()}
            aria-label="Close"
            className="text-fg-muted hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </dialog>
    );
  },
);
