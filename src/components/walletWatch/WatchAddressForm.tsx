"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import { watchAddress } from "@/app/(app)/wallet-watch/actions";
import { Field, inputClass, selectClass } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

export interface WatchFormOptions {
  influencers: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}

/**
 * Watch an address: under a new influencer or one already watched, in any
 * of the user's groups. Used on Wallet Watch (address typed in) and on the
 * lookup page (`address` fixed). Starts collapsed behind one button.
 */
export function WatchAddressForm({
  options,
  address: fixedAddress,
  influencerId: fixedInfluencerId,
  label = "Watch a wallet",
}: {
  options: WatchFormOptions;
  address?: string;
  influencerId?: string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Eye className="size-3.5" aria-hidden="true" />
        {label}
      </Button>
    );
  }

  function submit(form: FormData) {
    setError(null);
    start(async () => {
      const influencerId = fixedInfluencerId ?? (mode === "existing" ? String(form.get("influencerId") ?? "") : undefined);
      const r = await watchAddress({
        address: fixedAddress ?? String(form.get("address") ?? ""),
        influencerId: influencerId || undefined,
        name: String(form.get("name") ?? ""),
        link: String(form.get("link") ?? ""),
        groupIds: form.getAll("groupIds").map(String),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
      if (r.influencerId && !fixedInfluencerId) router.push(`/wallet-watch/${r.influencerId}`);
    });
  }

  return (
    <form action={submit} className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface-raised/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-fg">{label}</p>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-fg-muted hover:text-fg">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {fixedAddress ? (
        <p className="truncate text-xs text-fg-muted" title={fixedAddress}>
          {fixedAddress}
        </p>
      ) : (
        <Field label="Address" hint="Any address the search bar accepts (EVM, Solana, Bitcoin, …).">
          <input name="address" required autoFocus className={inputClass} placeholder="0x… or a Solana address" />
        </Field>
      )}

      {!fixedInfluencerId && (
        <>
          {options.influencers.length > 0 && (
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> New influencer
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Another address of…
              </label>
            </div>
          )}
          {mode === "existing" ? (
            <Field label="Influencer">
              <select name="influencerId" className={selectClass} required>
                {options.influencers.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <>
              <Field label="Name">
                <input name="name" required maxLength={80} className={inputClass} placeholder="e.g. Ansem" />
              </Field>
              <Field label="Link (optional)" hint="Their X or Farcaster profile.">
                <input name="link" type="url" className={inputClass} placeholder="https://x.com/…" />
              </Field>
              {options.groups.length > 0 && (
                <fieldset className="space-y-1 text-sm">
                  <legend className="mb-1 text-fg">Groups</legend>
                  {options.groups.map((g) => (
                    <label key={g.id} className="mr-4 inline-flex items-center gap-1.5">
                      <input type="checkbox" name="groupIds" value={g.id} /> {g.name}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
        </>
      )}

      {error && <p className="text-xs text-negative">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Watch"}
        </Button>
        <span className="text-xs text-fg-muted">Its holdings are read right after — about half a minute for an EVM address.</span>
      </div>
    </form>
  );
}
