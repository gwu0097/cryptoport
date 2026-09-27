"use client";

import { useState, useTransition } from "react";
import { Check, Share2, X } from "lucide-react";
import { shareInfluencer, unshareInfluencer } from "@/app/(app)/wallet-watch/actions";
import { Button } from "@/components/ui/Button";

const sharePath = (token: string) => `/wallet-watch/shared/${token}`;

/** Share an influencer with other signed-in users: creates the link on first
 * use and copies it; "Stop sharing" turns the link off. */
export function ShareInfluencerButton({ influencerId, shareToken }: { influencerId: string; shareToken: string | null }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const copy = (token: string) =>
    navigator.clipboard.writeText(`${window.location.origin}${sharePath(token)}`).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          title="A link other CryptoPort users can open (signed in) to see this influencer — read-only, without your note or groups"
          onClick={() =>
            start(async () => {
              setError(null);
              const r = shareToken ? { ok: true as const, token: shareToken } : await shareInfluencer(influencerId);
              if (r.ok) await copy(r.token);
              else setError(r.error);
            })
          }
        >
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Share2 className="size-3.5" aria-hidden="true" />}
          {copied ? "Link copied" : shareToken ? "Copy share link" : "Share"}
        </Button>
        {shareToken && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            title="Turn the share link off — anyone with it loses access"
            onClick={() =>
              start(async () => {
                const r = await unshareInfluencer(influencerId);
                if (!r.ok) setError(r.error);
              })
            }
          >
            <X className="size-3.5" aria-hidden="true" /> Stop sharing
          </Button>
        )}
      </span>
      {shareToken && <span className="text-xs text-fg-muted">Shared — signed-in users with the link can view it</span>}
      {error && <span className="text-xs text-negative">{error}</span>}
    </span>
  );
}
