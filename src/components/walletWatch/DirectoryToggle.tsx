"use client";

import { useState, useTransition } from "react";
import { BookUser } from "lucide-react";
import { setInDirectory } from "@/app/(app)/wallet-watch/actions";
import { Button } from "@/components/ui/Button";

/** Owner only: puts this influencer in the KOL directory, where every user
 * can add it as a copy that follows this one's addresses. */
export function DirectoryToggle({ influencerId, inDirectory }: { influencerId: string; inDirectory: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span className={`inline-flex items-center gap-1.5 ${inDirectory ? "text-accent" : "text-fg-muted"}`}>
        <BookUser className="size-3.5" aria-hidden="true" />
        {inDirectory ? "In the KOL directory" : "Not in the KOL directory"}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        title="Owner only. Directory entries are shared: anyone can add this influencer, and your address changes reach their copies."
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await setInDirectory(influencerId, !inDirectory);
            if (!r.ok) setError(r.error);
          })
        }
      >
        {pending ? "Updating…" : inDirectory ? "Remove from directory" : "Add to directory"}
      </Button>
      {error && <span className="text-xs text-warning">{error}</span>}
    </div>
  );
}
