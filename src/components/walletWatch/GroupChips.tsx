"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import type { WatchGroup } from "@/lib/watchQuery";
import { setInfluencerGroup } from "@/app/(app)/wallet-watch/actions";

/** An influencer's groups as chips: pressed = in the group (owner
 * 2026-09-30: groups near the top, not a row of checkboxes). One click adds
 * or removes one group. Another member's influencer (a shared group's) shows
 * only the groups it's in — you can take it out, not add it elsewhere. */
export function GroupChips({ influencerId, groupIds, groups, mine = true }: { influencerId: string; groupIds: string[]; groups: WatchGroup[]; mine?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const shown = mine ? groups : groups.filter((g) => groupIds.includes(g.id));
  if (groups.length === 0) {
    return (
      <Link href="/wallet-watch" className="mt-1.5 inline-block text-xs text-fg-muted hover:text-accent">
        No groups yet — create one on Wallet Watch
      </Link>
    );
  }
  const toggle = (id: string) =>
    start(async () => {
      const r = await setInfluencerGroup(influencerId, id, !groupIds.includes(id));
      setError(r.ok ? null : r.error);
    });
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {shown.map((g) => {
        const on = groupIds.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            aria-pressed={on}
            disabled={pending}
            onClick={() => toggle(g.id)}
            title={g.shared ? "A shared group" : undefined}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition disabled:opacity-60 ${on ? "border-accent bg-accent/15 text-accent" : "border-border text-fg-muted hover:text-fg"}`}
          >
            {g.shared && <Users className="size-3" aria-hidden="true" />}
            {g.name}
          </button>
        );
      })}
      {error && <span className="text-xs text-negative">{error}</span>}
    </span>
  );
}
