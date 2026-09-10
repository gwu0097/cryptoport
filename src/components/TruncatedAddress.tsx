"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** Shows first5...last5 (the common convention for a value too long to
 * display in full — an xpub is 111 characters) with the full value in a
 * native `title` tooltip, plus a one-click copy-to-clipboard button. Client
 * component only for the clipboard call; the truncation itself is plain
 * string slicing, no interactivity needed for that part. */
export function TruncatedAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const truncated = address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail (permissions, insecure context) — a copy
      // convenience button isn't worth surfacing an error for.
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span title={address} className="cursor-default">
        {truncated}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy address"}
        className="text-fg-muted hover:text-fg"
      >
        {copied ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
