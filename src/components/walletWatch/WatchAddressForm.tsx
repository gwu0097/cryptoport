"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import { watchAddress, watchAddresses, type BulkAddResult } from "@/app/(app)/wallet-watch/actions";
import { BULK_MAX, parseBulk } from "@/lib/watchBulk";
import { Field, inputClass, selectClass } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

export interface WatchFormOptions {
  influencers: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}

/**
 * Watch an address: under a new influencer or one already watched, in any
 * of the user's groups. Used on Wallet Watch (address typed in) and on the
 * lookup page (`address` fixed). Starts collapsed behind one button. On
 * Wallet Watch it also takes several at once (owner 2026-10-07): a pasted
 * list, one wallet a line, each a new influencer (BulkWatch).
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
  const [many, setMany] = useState(false);
  const canBulk = !fixedAddress && !fixedInfluencerId;
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

  const header = (
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-medium text-fg">{label}</p>
      <div className="flex items-center gap-2">
        {canBulk && (
          <div className="flex rounded-md border border-border text-xs" role="group" aria-label="How many">
            {[false, true].map((m) => (
              <button key={String(m)} type="button" onClick={() => setMany(m)} className={`px-2 py-1 ${many === m ? "bg-surface-raised text-fg" : "text-fg-muted hover:text-fg"}`} aria-pressed={many === m}>
                {m ? "Several" : "One wallet"}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-fg-muted hover:text-fg">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  if (canBulk && many) {
    return (
      <div className="w-full max-w-xl space-y-3 rounded-lg border border-border bg-surface-raised/40 p-4">
        {header}
        <BulkWatch groups={options.groups} />
      </div>
    );
  }

  return (
    <form action={submit} className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface-raised/40 p-4">
      {header}
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

/** Several wallets at once: paste, check the preview, add. Each line is a
 * new influencer in the ticked groups; every line gets its own result. */
function BulkWatch({ groups }: { groups: WatchFormOptions["groups"] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [results, setResults] = useState<BulkAddResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const parsed = useMemo(() => parseBulk(text), [text]);

  function add() {
    setError(null);
    start(async () => {
      const r = await watchAddresses({ text, groupIds });
      if (!r.ok) return setError(r.error);
      setResults(r.results);
      if (r.results.some((x) => x.ok)) router.refresh();
    });
  }

  if (results) {
    const added = results.filter((r) => r.ok).length;
    return (
      <div className="space-y-2">
        <p className="text-sm text-fg">
          Added {added} of {results.length}.{added > 0 && " Their holdings are being read now — a few minutes for a batch."}
        </p>
        <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
          {results.map((r) => (
            <li key={r.line} className="flex items-baseline gap-2">
              <span className={r.ok ? "text-positive" : "text-negative"}>{r.ok ? "✓" : "✗"}</span>
              {r.influencerId ? (
                <Link href={`/wallet-watch/${r.influencerId}`} className="font-medium text-fg hover:text-accent">
                  {r.name}
                </Link>
              ) : (
                <span className="font-medium text-fg">{r.name || `Line ${r.line}`}</span>
              )}
              <span className="truncate text-fg-muted" title={r.address}>
                {r.address.length > 20 ? `${r.address.slice(0, 6)}…${r.address.slice(-4)}` : r.address}
              </span>
              {r.error && <span className="text-fg-muted">— {r.error}</span>}
            </li>
          ))}
        </ul>
        <Button type="button" variant="secondary" size="sm" onClick={() => (setResults(null), setText(""))}>
          Add more
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Wallets" hint={`One a line: a name and the address, in either order (up to ${BULK_MAX}). No name: its short address.`}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} autoFocus spellCheck={false} className={`${inputClass} font-mono text-xs`} placeholder={"Swing 4a7N   4a7NWcurNg4y…\nAnsem, 0x…"} />
      </Field>
      {(parsed.lines.length > 0 || parsed.problems.length > 0) && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
          {parsed.lines.map((l) => (
            <li key={l.line} className="flex gap-2">
              <span className="text-fg">{l.name ?? <span className="text-fg-muted">(short address)</span>}</span>
              <span className="truncate text-fg-muted" title={l.address}>
                {l.address.slice(0, 6)}…{l.address.slice(-4)}
              </span>
            </li>
          ))}
          {parsed.problems.map((p) => (
            <li key={`p${p.line}`} className="text-negative">
              Line {p.line}: {p.error}
            </li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-fg">Groups for all of them</legend>
          {groups.map((g) => (
            <label key={g.id} className="mr-4 inline-flex items-center gap-1.5">
              <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))} /> {g.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && <p className="text-xs text-negative">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={pending || parsed.lines.length === 0} onClick={add}>
          {pending ? `Adding ${parsed.lines.length}…` : `Watch ${parsed.lines.length || ""} wallet${parsed.lines.length === 1 ? "" : "s"}`}
        </Button>
        {parsed.problems.length > 0 && <span className="text-xs text-fg-muted">Lines with a problem are skipped.</span>}
      </div>
    </div>
  );
}
