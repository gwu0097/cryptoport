"use client";

import { useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";

/** Copies a coin's contract, fetched on the first click (api/coin-contract):
 * nothing is read until someone wants it. A native coin has none. */
export function CopyCoinContract({ priceKey, ticker }: { priceKey: string; ticker: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "none" | "error">("idle");
  const [found, setFound] = useState<{ contract: string; chain: string } | null>(null);

  async function copy(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    e.preventDefault();
    try {
      let hit = found;
      if (!hit) {
        setState("busy");
        const res = await fetch(`/api/coin-contract?key=${encodeURIComponent(priceKey)}`);
        const body = (await res.json()) as { contract?: string | null; chain?: string };
        if (!body.contract) return setState("none");
        hit = { contract: body.contract, chain: body.chain ?? "" };
        setFound(hit);
      }
      await navigator.clipboard.writeText(hit.contract);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("error");
    }
  }

  const title =
    state === "none" ? `${ticker} is a native coin — no contract` : state === "error" ? "Couldn't copy" : found ? `Copy ${ticker}'s contract (${found.chain}): ${found.contract}` : `Copy ${ticker}'s contract`;
  return (
    <button type="button" onClick={copy} disabled={state === "busy" || state === "none"} aria-label={`Copy ${ticker}'s contract`} title={title} className="shrink-0 rounded p-0.5 text-fg-muted transition hover:text-fg disabled:opacity-40">
      {state === "copied" ? <Check className="size-3 text-positive" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
    </button>
  );
}
