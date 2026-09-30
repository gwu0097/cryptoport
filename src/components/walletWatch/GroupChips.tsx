"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { WatchGroup } from "@/lib/watchQuery";
import { setInfluencerGroups } from "@/app/(app)/wallet-watch/actions";

/** An influencer's groups as chips under its title: pressed = in the group
 * (owner 2026-09-30: groups near the top, not a row of checkboxes). */
export function GroupChips({ influencerId, groupIds, groups }: { influencerId: string; groupIds: string[]; groups: WatchGroup[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (groups.length === 0) {
    return (
      <Link href="/wallet-watch" className="mt-1.5 inline-block text-xs text-fg-muted hover:text-accent">
        No groups yet — create one on Wallet Watch
      </Link>
    );
  }
  const toggle = (id: string) =>
    start(async () => {
      const next = groupIds.includes(id) ? groupIds.filter((g) => g !== id) : [...groupIds, id];
      const r = await setInfluencerGroups(influencerId, next);
      setError(r.ok ? null : r.error);
    });
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {groups.map((g) => {
        const on = groupIds.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            aria-pressed={on}
            disabled={pending}
            onClick={() => toggle(g.id)}
            className={`rounded-full border px-2 py-0.5 text-xs transition disabled:opacity-60 ${on ? "border-accent bg-accent/15 text-accent" : "border-border text-fg-muted hover:text-fg"}`}
          >
            {g.name}
          </button>
        );
      })}
      {error && <span className="text-xs text-negative">{error}</span>}
    </span>
  );
}
