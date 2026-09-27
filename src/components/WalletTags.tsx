"use client";

import { useState, useTransition } from "react";
import { Plus, Tag } from "lucide-react";
import { setWalletTags } from "@/app/(app)/wallets/actions";
import { TagPicker } from "./TagPicker";
import { Button } from "./ui/Button";

/** A wallet's tags on its own page: shown as chips, edited in place with the
 * same picker as the Edit wallet form (existing tags or a new name). */
export function WalletTags({ walletId, tags, allTags }: { walletId: string; tags: string[]; allTags: string[] }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg">
            <Tag className="size-3 text-fg-muted" aria-hidden="true" />
            {t}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-fg-muted hover:border-accent hover:text-fg"
        >
          <Plus className="size-3" aria-hidden="true" />
          {tags.length === 0 ? "Add tag" : "Tag"}
        </button>
      </span>
    );
  }

  return (
    <form
      action={(form) =>
        start(async () => {
          setError(null);
          try {
            await setWalletTags(walletId, form);
            setEditing(false);
          } catch (e) {
            setError((e as Error).message);
          }
        })
      }
      className="flex w-full max-w-md flex-col gap-2"
    >
      <TagPicker allTags={allTags} defaultSelected={tags} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save tags"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {error && <span className="text-xs text-negative">{error}</span>}
      </div>
    </form>
  );
}
