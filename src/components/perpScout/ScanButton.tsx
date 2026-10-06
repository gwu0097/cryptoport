"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Radar } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AgeText } from "@/components/AgeText";

type Line =
  | { type: "progress"; stage: "saving" }
  | { type: "progress"; stage: "positions"; done: number; total: number }
  | { type: "end"; status?: "done" | "fresh" | "busy" | "none"; failed?: number; error?: string };

function describe(line: Extract<Line, { type: "progress" }>): string {
  switch (line.stage) {
    case "positions":
      return `Reading positions ${line.done}/${line.total}…`;
    case "saving":
      return "Saving…";
  }
}

/** Scan: streams the scan's steps (api/perp-scout/scan), then re-renders the
 * page. Owns its status line (when last scanned, errors). */
export function ScanButton({ signedIn, scannedAt, serverNowSec }: { signedIn: boolean; scannedAt: string | null; serverNowSec: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = status !== null;

  async function scan() {
    setNote(null);
    setStatus("Starting…");
    try {
      const res = await fetch("/api/perp-scout/scan", { method: "POST", cache: "no-store" });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let end: Extract<Line, { type: "end" }> | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const text of lines) {
          if (!text.trim()) continue;
          const line = JSON.parse(text) as Line;
          if (line.type === "progress") setStatus(describe(line));
          else end = line;
        }
        if (done) break;
      }
      if (!end) throw new Error("The scan stopped without finishing — try again");
      if (end.error) throw new Error(end.error);
      if (end.status === "busy") setNote("A scan is already running — its results will show when it finishes.");
      else if (end.status === "fresh") setNote("Scanned under a minute ago — showing that.");
      else if (end.status === "none") setNote("No traders on the list yet.");
      else if (end.failed) setNote(`${end.failed} trader${end.failed === 1 ? "" : "s"} couldn't be read; their last entries are kept.`);
      router.refresh();
    } catch (e) {
      setNote(`Scan failed: ${(e as Error).message}`);
    } finally {
      setStatus(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <div className="flex items-center gap-2">
        <Button disabled={busy || !signedIn} onClick={scan} title={signedIn ? undefined : "Sign in to scan"}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Radar className="size-4" aria-hidden="true" />}
          {busy ? "Scanning…" : "Scan"}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        {status ??
          (scannedAt ? (
            <AgeText at={scannedAt} serverNowSec={serverNowSec} prefix="Positions read " />
          ) : signedIn ? (
            "Not scanned yet"
          ) : (
            "Sign in to scan"
          ))}
      </p>
      {note && <p className="max-w-xs text-xs text-warning">{note}</p>}
    </div>
  );
}
