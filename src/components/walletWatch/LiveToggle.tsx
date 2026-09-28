"use client";

import { useState, useTransition } from "react";
import { Radio } from "lucide-react";
import { setInfluencerLive } from "@/app/(app)/wallet-watch/actions";
import { AgeText } from "@/components/AgeText";
import { Button } from "@/components/ui/Button";

/** Owner only: live updates for this influencer via the Helius webhook
 * (phase 5) — each delivered transaction is 1 Helius credit. */
export function LiveToggle({ influencerId, live, liveSince, lastEventAt, serverNowSec }: { influencerId: string; live: boolean; liveSince: string | null; lastEventAt: string | null; serverNowSec: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span className={`inline-flex items-center gap-1.5 ${live ? "text-positive" : "text-fg-muted"}`}>
        <Radio className={`size-3.5 ${live ? "animate-pulse" : ""}`} aria-hidden="true" />
        Live updates {live ? "on" : "off"}
      </span>
      {live && (
        <span className="text-xs text-fg-muted">
          since <AgeText at={liveSince} serverNowSec={serverNowSec} /> · last delivery {lastEventAt ? <AgeText at={lastEventAt} serverNowSec={serverNowSec} /> : "none yet"}
        </span>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        title="Owner only. A Helius webhook pushes this wallet's trades as they happen: 1 credit per transaction, 100 per change to the webhook."
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await setInfluencerLive(influencerId, !live);
            if (!r.ok) setError(r.error);
          })
        }
      >
        {pending ? "Updating…" : live ? "Turn off" : "Turn on"}
      </Button>
      {error && <span className="text-xs text-warning">{error}</span>}
    </div>
  );
}
