"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { FollowedTrader } from "@/lib/perpScout/followed";
import { parseTraderImport, tradersToCsv } from "@/lib/perpScout/traderFile";

/** Export: the list as a CSV file, built in the browser (no request). */
export function ExportTradersButton({ traders }: { traders: readonly FollowedTrader[] }) {
  function download() {
    const url = URL.createObjectURL(new Blob([tradersToCsv(traders)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `perp-scout-traders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoked once the download has started (at once, Chrome cancels it).
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Button variant="secondary" size="sm" disabled={traders.length === 0} onClick={download} title="Download the list as CSV (address, name, added, why)">
      <Download className="size-3.5" aria-hidden="true" />
      Export
    </Button>
  );
}

type Result = { address: string; ok: true; restored: boolean } | { address: string; ok: false; error: string };

/**
 * Owner only: import traders from a file or pasted text — an Export's CSV,
 * Perp Scout JSON, or one address per line with an optional name after a
 * comma. Each new address has its Hyperliquid record read (about a second
 * each); ones already listed are skipped.
 */
export function ImportTraders() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string; details: string[] } | null>(null);
  const parsed = parseTraderImport(text);

  async function readFile(file: File | undefined) {
    if (file) setText(await file.text());
  }

  async function submit() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/perp-scout/traders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ import: parsed.traders }) });
      const body = (await res.json().catch(() => ({}))) as { results?: Result[]; error?: string };
      if (!res.ok || !body.results) throw new Error(body.error ?? `HTTP ${res.status}`);
      const added = body.results.filter((r) => r.ok).length;
      const failed = body.results.filter((r): r is Extract<Result, { ok: false }> => !r.ok);
      setNote({
        tone: failed.length ? "warn" : "ok",
        text: `Added ${added} of ${body.results.length}${added ? " — press Scan to read their positions" : ""}.`,
        details: failed.map((r) => `${r.address.slice(0, 6)}…${r.address.slice(-4)}: ${r.error}`),
      });
      if (added) {
        setText("");
        router.refresh();
      }
    } catch (e) {
      setNote({ tone: "warn", text: `Import failed: ${(e as Error).message}`, details: [] });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} title="Add traders from a CSV, JSON or a list of addresses">
        <Upload className="size-3.5" aria-hidden="true" />
        Import
      </Button>
    );
  }
  return (
    <div className="mt-4 w-full space-y-2 border-t border-border pt-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={"Paste addresses, one per line, with an optional name after a comma:\n0x1234…abcd, Swing trader\nor choose an exported CSV / JSON file"}
        className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".csv,.txt,.json,text/csv,text/plain,application/json" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          Choose file…
        </Button>
        <Button size="sm" onClick={submit} disabled={busy || parsed.traders.length === 0}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Upload className="size-3.5" aria-hidden="true" />}
          {busy ? `Checking ${parsed.traders.length} record${parsed.traders.length === 1 ? "" : "s"}…` : `Import ${parsed.traders.length || ""} trader${parsed.traders.length === 1 ? "" : "s"}`}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Close
        </Button>
        {parsed.skipped > 0 && <span className="text-xs text-warning">{parsed.skipped} line{parsed.skipped === 1 ? "" : "s"} without an address skipped</span>}
        {note && <span className={`text-xs ${note.tone === "ok" ? "text-fg-muted" : "text-warning"}`}>{note.text}</span>}
      </div>
      {note && note.details.length > 0 && (
        <ul className="space-y-0.5 text-xs text-warning">
          {note.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
