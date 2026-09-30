"use client";

import { useEffect, useState, useTransition } from "react";
import { watchGroupCookie } from "@/lib/watchGroupCookie";
import { ConfirmActionButton } from "../ui/ConfirmActionButton";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Plus, Trash2, Users, X } from "lucide-react";
import { GroupShareControls } from "./GroupShareControls";
import { InlineName } from "@/components/ui/InlineName";
import { createGroup, deleteGroup, renameGroup, type WatchActionResult } from "@/app/(app)/wallet-watch/actions";
import { inputClass } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import type { WatchGroup } from "@/lib/watchQuery";

const tabClass = (active: boolean) =>
  "rounded-lg px-3 py-1.5 text-sm transition " +
  (active ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-raised hover:text-fg");

/** One-line name editor for creating or renaming a group. */
function NameForm({ initial, onSubmit, onDone }: { initial?: string; onSubmit: (name: string) => Promise<WatchActionResult>; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      action={(form) =>
        start(async () => {
          const r = await onSubmit(String(form.get("name") ?? ""));
          if (r.ok) onDone();
          else setError(r.error);
        })
      }
      className="flex items-center gap-2"
    >
      <input name="name" autoFocus required maxLength={60} defaultValue={initial} placeholder="Group name, e.g. Gem pickers" className={`${inputClass} w-48 py-1.5`} />
      <Button type="submit" size="sm" disabled={pending}>
        <Check className="size-3.5" aria-hidden="true" />
      </Button>
      <button type="button" onClick={onDone} aria-label="Cancel" className="rounded p-1 text-fg-muted hover:text-fg">
        <X className="size-4" aria-hidden="true" />
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </form>
  );
}

/**
 * All + one tab per group (the URL's ?group= is the selection), with New
 * group; the selected one renames beside its tab and has Delete. Deleting a group never
 * removes its influencers.
 */
export function GroupTabs({ groups, selected, counts }: { groups: WatchGroup[]; selected: WatchGroup | null; counts: Record<string, number> & { all: number } }) {
  const router = useRouter();
  const [editing, setEditing] = useState<"new" | null>(null);
  const [pending, start] = useTransition();
  // Remembered for the next visit without a group in the link.
  useEffect(() => {
    document.cookie = watchGroupCookie(selected?.id ?? "all");
  }, [selected?.id]);

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/wallet-watch?group=all" className={tabClass(selected === null)}>
          All <span className="opacity-70">({counts.all})</span>
        </Link>
        {groups.map((g) =>
          selected?.id === g.id && g.mine !== false ? (
            // The selected group renames beside its own tab (InlineName).
            <InlineName key={g.id} name={g.name} label="Rename group" maxLength={60} onSave={async (name) => {
              const r = await renameGroup(g.id, name);
              return r.ok ? null : r.error;
            }}>
              <Link href={`/wallet-watch?group=${g.id}`} className={`${tabClass(true)} inline-flex items-center gap-1`}>
                {g.shared && <Users className="size-3.5" aria-label="Shared" />}
                {g.name} <span className="opacity-70">({counts[g.id] ?? 0})</span>
              </Link>
            </InlineName>
          ) : (
            <Link key={g.id} href={`/wallet-watch?group=${g.id}`} className={`${tabClass(selected?.id === g.id)} inline-flex items-center gap-1`} title={g.shared ? (g.mine ? "Shared by you" : "Shared with you") : undefined}>
              {g.shared && <Users className="size-3.5" aria-label="Shared" />}
              {g.name} <span className="opacity-70">({counts[g.id] ?? 0})</span>
            </Link>
          ),
        )}
        {editing === "new" ? (
          <NameForm onSubmit={createGroup} onDone={() => setEditing(null)} />
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-3.5" aria-hidden="true" />
            New group
          </Button>
        )}
      </div>
      {selected && (
        <div className="flex items-start gap-2">
          <GroupShareControls group={selected} />
          {selected.mine !== false && (
              <ConfirmActionButton
                message={`Delete the group "${selected.name}"? Its influencers stay in Wallet Watch.`}
                confirmLabel="Delete group"
                disabled={pending}
                onConfirm={() =>
                  start(async () => {
                    const r = await deleteGroup(selected.id);
                    if (r.ok) router.push("/wallet-watch?group=all");
                  })
                }
                trigger={(open) => (
                  <Button type="button" variant="danger" size="sm" disabled={pending} onClick={open}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    Delete group
                  </Button>
                )}
              />
          )}
        </div>
      )}
    </div>
  );
}
