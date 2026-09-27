"use client";

import { useState, useTransition } from "react";
import { setWalletTags } from "@/app/(app)/wallets/actions";
import { Dialog } from "./ui/Dialog";
import { useLazyDialog } from "./ui/useLazyDialog";
import { TagPicker } from "./TagPicker";
import { Button } from "./ui/Button";

/**
 * A wallet's tag cell on the Wallets list: the tags (or "—"), clickable to
 * open a small window that adds or removes them — existing tags or a new
 * name, the same picker as the Edit wallet form.
 */
export function WalletTagsCell({ walletId, walletName, tags, allTags }: { walletId: string; walletName: string; tags: string[]; allTags: string[] }) {
  const { dialogRef, open, openDialog } = useLazyDialog();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title="Add or remove tags"
        className="-mx-1 flex flex-wrap items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-surface-raised/60"
      >
        {tags.length > 0 ? (
          tags.map((t) => (
            <span key={t} className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
              {t}
            </span>
          ))
        ) : (
          <span className="px-1 text-fg-muted">—</span>
        )}
      </button>
      <Dialog ref={dialogRef} title={`Tags · ${walletName}`}>
        {open && (
          <form
            action={(form) =>
              start(async () => {
                setError(null);
                try {
                  await setWalletTags(walletId, form);
                  dialogRef.current?.close();
                } catch (e) {
                  setError((e as Error).message);
                }
              })
            }
            className="space-y-3"
          >
            <TagPicker allTags={allTags} defaultSelected={tags} />
            <p className="text-xs text-fg-muted">Pick existing tags or type a new name and press Enter. Remove one with its ×.</p>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save tags"}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => dialogRef.current?.close()}>
                Cancel
              </Button>
              {error && <span className="text-xs text-negative">{error}</span>}
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
