"use client";

import { useState, useTransition } from "react";
import { checkSuggestion, decideSuggestion } from "@/app/(app)/wallet-watch/actions";
import { Button } from "@/components/ui/Button";
import type { LinkEvidence } from "@/lib/walletLinks";

const STRENGTH: Record<LinkEvidence["strength"], { label: string; tone: string; note: string }> = {
  strong: { label: "Linked both ways", tone: "text-positive", note: "money moved in both directions, more than once" },
  "one-way": { label: "One-way only", tone: "text-warning", note: "anyone can send tokens to any wallet — not proof on its own" },
  none: { label: "No transfers found", tone: "text-negative", note: "no money moved between it and the KOL's known wallets" },
};

/** One pending suggestion's review: the evidence check, then approve or
 * reject. Approving adds the wallet to the KOL and every copy of it. */
export function SuggestionReview({ id, pending, evidence: stored }: { id: string; pending: boolean; evidence: LinkEvidence | null }) {
  const [evidence, setEvidence] = useState(stored);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (f: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await f();
      if (!r.ok) setError(r.error ?? "Failed");
    });
  const s = evidence ? STRENGTH[evidence.strength] : null;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {evidence && s && (
        <p>
          <span className={`font-medium ${s.tone}`}>{s.label}</span>
          <span className="text-fg-muted"> — {s.note}</span>
          {evidence.strength !== "none" && (
            <span className="block text-fg-muted">
              {evidence.toSuggested} to it · {evidence.fromSuggested} from it · {evidence.chains.join(", ")}
              {evidence.assets.length > 0 && ` · ${evidence.assets.join(", ")}`}
              {evidence.first && ` · ${evidence.first.slice(0, 10)} → ${evidence.last?.slice(0, 10)}`}
            </span>
          )}
        </p>
      )}
      {pending && (
        <span className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            title="Reads the transfers between this wallet and the KOL's known wallets (a few Alchemy or Helius calls)."
            onClick={() =>
              run(async () => {
                const r = await checkSuggestion(id);
                if (r.ok) setEvidence(r.evidence);
                return r;
              })
            }
          >
            {busy ? "Working…" : evidence ? "Check again" : "Check links"}
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => run(() => decideSuggestion(id, true))}>
            Approve
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => run(() => decideSuggestion(id, false))}>
            Reject
          </Button>
        </span>
      )}
      {error && <span className="text-warning">{error}</span>}
    </div>
  );
}
