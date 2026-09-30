"use client";

import { useState, useTransition } from "react";
import { ConfirmActionButton } from "../ui/ConfirmActionButton";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, X } from "lucide-react";
import { removeInfluencer, removeWatchedAddress, updateInfluencer } from "@/app/(app)/wallet-watch/actions";
import { Field, inputClass } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

/** Name, link and note of one influencer; remove it (its groups: GroupChips). */
export function InfluencerEditor({ influencer }: { influencer: { id: string; name: string; link: string | null; note: string | null; groupIds: string[] } }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-3">
      {editing ? (
        <form
          action={(form) =>
            start(async () => {
              const r = await updateInfluencer(influencer.id, {
                name: String(form.get("name") ?? ""),
                link: String(form.get("link") ?? ""),
                note: String(form.get("note") ?? ""),
              });
              if (r.ok) setEditing(false);
              else setError(r.error);
            })
          }
          className="max-w-md space-y-3"
        >
          <Field label="Name">
            <input name="name" required maxLength={80} defaultValue={influencer.name} className={inputClass} />
          </Field>
          <Field label="Link">
            <input name="link" type="url" defaultValue={influencer.link ?? ""} className={inputClass} placeholder="https://x.com/…" />
          </Field>
          <Field label="Note" hint="Why you follow them, what they're known for.">
            <textarea name="note" maxLength={2000} rows={3} defaultValue={influencer.note ?? ""} className={inputClass} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
              <X className="size-3.5" aria-hidden="true" /> Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden="true" /> Edit
          </Button>
          <ConfirmActionButton
            message={`Stop watching ${influencer.name}? Their addresses leave your Wallet Watch.`}
            confirmLabel="Stop watching"
            disabled={pending}
            onConfirm={() =>
              start(async () => {
                const r = await removeInfluencer(influencer.id);
                if (r.ok) router.push("/wallet-watch");
                else setError(r.error);
              })
            }
            trigger={(open) => (
              <Button type="button" variant="danger" size="sm" disabled={pending} onClick={open}>
                <Trash2 className="size-3.5" aria-hidden="true" /> Stop watching
              </Button>
            )}
          />
        </div>
      )}

      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}

/** Removes one address from an influencer. */
export function RemoveAddressButton({ addressId, influencerId, address }: { addressId: string; influencerId: string; address: string }) {
  const [pending, start] = useTransition();
  return (
    <ConfirmActionButton
      message={`Remove ${address.slice(0, 6)}…${address.slice(-4)}?`}
      confirmLabel="Remove"
      disabled={pending}
      onConfirm={() =>
        start(async () => {
          await removeWatchedAddress(addressId, influencerId);
        })
      }
      trigger={(open) => (
        <button type="button" disabled={pending} aria-label="Remove this address" title="Remove this address" className="rounded p-1 text-fg-muted hover:text-negative disabled:opacity-50" onClick={open}>
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      )}
    />
  );
}
