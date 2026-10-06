"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** Owner only: add a trader to Perp Scout's list by address (and a name).
 * The route reads its Hyperliquid record once; its positions show after the
 * next Scan. */
export function AddTraderForm() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const res = await fetch("/api/perp-scout/traders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, name }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setAdded(name.trim() || address.trim());
      setAddress("");
      setName("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none";
  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Trader address (0x…)" aria-label="Trader address" className={`${input} w-full font-mono sm:w-[26rem]`} spellCheck={false} autoComplete="off" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" maxLength={40} className={`${input} w-full sm:w-48`} />
      <Button type="submit" size="sm" disabled={busy || !address.trim()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
        {busy ? "Checking its record…" : "Add trader"}
      </Button>
      {error && <span className="text-xs text-warning">{error}</span>}
      {added && !error && <span className="text-xs text-fg-muted">Added {added} — press Scan to read its positions.</span>}
    </form>
  );
}
