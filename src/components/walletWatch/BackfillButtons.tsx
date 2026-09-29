"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { HISTORY_DAYS, type HistoryDays } from "@/lib/watchHistory";
import type { BackfillResult } from "@/lib/watchHistoryLoad";

/** Fills the Activity list for the 7 or 30 days before this influencer's
 * addresses were first read, from their transactions (watchHistoryLoad.ts).
 * The lines are kept; a second press reads only what's new. */
export function BackfillButtons({ influencerId }: { influencerId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<HistoryDays | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(days: HistoryDays) {
    setBusy(days);
    setNote(null);
    try {
      const res = await fetch("/api/wallet-watch/backfill", { method: "POST", body: JSON.stringify({ influencerId, days }) });
      const body = (await res.json()) as { result: BackfillResult } | { error: string };
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      const r = body.result;
      const lines = r.written.reduce((n, w) => n + w.movements, 0);
      const parts = [
        r.written.length === 0 && r.coveredByReads > 0 ? `already watched for over ${days} days — the daily reads cover it` : `${lines} line${lines === 1 ? "" : "s"} from ${r.written.length} wallet${r.written.length === 1 ? "" : "s"}`,
        r.reads === 0 ? "from stored history" : `${r.reads} chain read${r.reads === 1 ? "" : "s"}`,
        r.skippedSolana > 0 ? `${r.skippedSolana} Solana wallet${r.skippedSolana === 1 ? "" : "s"} skipped (owner only)` : "",
        r.partial.length > 0 ? `partial on ${r.partial.join(", ")}` : "",
        r.failed.length > 0 ? `not read: ${r.failed.join("; ")}` : "",
      ].filter(Boolean);
      setNote({ ok: r.failed.length === 0, text: parts.join(" · ") });
      router.refresh();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      {HISTORY_DAYS.map((d) => (
        <Button key={d} type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(d)} title={`Fills the Activity list for the ${d} days before these wallets were first read, from their transactions. Kept — a second press reads only what's new.`}>
          <History className="size-3.5" aria-hidden="true" />
          {busy === d ? `Reading ${d} days…` : `Backfill ${d} days`}
        </Button>
      ))}
      {busy !== null && <span className="text-fg-muted">each wallet, each chain — up to a minute</span>}
      {note && <span className={note.ok ? "text-fg-muted" : "text-warning"}>{note.text}</span>}
    </div>
  );
}
