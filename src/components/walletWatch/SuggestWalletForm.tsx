"use client";

import { useState, useTransition } from "react";
import { Lightbulb } from "lucide-react";
import { suggestWallet } from "@/app/(app)/wallet-watch/actions";
import { Button } from "@/components/ui/Button";

/** Suggest a wallet for a directory KOL. It reaches nobody until the owner
 * approves it (with the on-chain evidence in the Owner's console). */
export function SuggestWalletForm({ influencerId, name }: { influencerId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
        <Lightbulb className="size-3" aria-hidden="true" /> Suggest a wallet
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-col gap-1.5 text-left"
      action={(form) =>
        start(async () => {
          const r = await suggestWallet({ influencerId, address: String(form.get("address") ?? ""), reason: String(form.get("reason") ?? ""), link: String(form.get("link") ?? "") });
          setMessage(r.ok ? { ok: true, text: "Sent — it's added for everyone once it's checked." } : { ok: false, text: r.error });
          if (r.ok) setOpen(false);
        })
      }
    >
      <input name="address" required placeholder={`A wallet of ${name} (0x… or Solana)`} className="w-72 max-w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg" />
      <input name="reason" maxLength={500} placeholder="How do you know? (optional)" className="w-72 max-w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg" />
      <input name="link" placeholder="A link that shows it — their post, an explorer label (optional)" className="w-72 max-w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg" />
      <span className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Sending…" : "Suggest"}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
      {message && <span className={`text-xs ${message.ok ? "text-positive" : "text-warning"}`}>{message.text}</span>}
    </form>
  );
}
