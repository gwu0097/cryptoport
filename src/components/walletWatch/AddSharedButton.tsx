"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { addSharedInfluencer } from "@/app/(app)/wallet-watch/actions";
import { Button } from "@/components/ui/Button";

/** Copies a shared influencer into the viewer's own Wallet Watch. */
export function AddSharedButton({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await addSharedInfluencer(token);
            if (r.ok && r.influencerId) router.push(`/wallet-watch/${r.influencerId}`);
            else if (!r.ok) setError(r.error);
          })
        }
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {pending ? "Adding…" : "Add to my Wallet Watch"}
      </Button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </span>
  );
}
