"use client";

import { useState, useTransition } from "react";
import { Link2 } from "lucide-react";
import { stopFollowing } from "@/app/(app)/wallet-watch/actions";

/** On a copy made from a share link: its addresses follow the original's
 * (watchCopySync.ts), until the user stops following. */
export function FollowingNote({ influencerId }: { influencerId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
      <Link2 className="size-3.5" aria-hidden="true" />
      Follows the shared list it was copied from — addresses added or removed there change here too.
      <button
        type="button"
        disabled={pending}
        className="text-fg-muted underline hover:text-fg disabled:opacity-50"
        onClick={() =>
          start(async () => {
            const r = await stopFollowing(influencerId);
            if (!r.ok) setError(r.error);
          })
        }
      >
        {pending ? "Stopping…" : "Stop following"}
      </button>
      {error && <span className="text-warning">{error}</span>}
    </p>
  );
}
