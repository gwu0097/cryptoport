"use client";

import { useState, type MouseEvent } from "react";
import { Copy, Check } from "lucide-react";

/** Small icon-only copy-to-clipboard button — same copied-state flash as
 * TruncatedAddress's built-in one (wallet addresses), factored out for
 * reuse anywhere that just needs the button next to already-visible text
 * (a holding's ticker/contract), not a truncated-value display alongside
 * it. stopPropagation matters here specifically because every caller so
 * far sits inside a clickable table row (AssetsTable's expand-on-click). */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail (permissions, insecure context) — a copy
      // convenience button isn't worth surfacing an error for.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className="shrink-0 text-fg-muted hover:text-fg"
    >
      {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
    </button>
  );
}
