"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Copies a full link to one or more app pages (one per line), built from the
 * site the user is on, so it works on any deployment. For pages anyone can
 * open without an account — the address lookup (/lookup) is public.
 */
export function ShareLinkButton({ paths, label = "Copy share link", compact = false }: { paths: string[]; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(paths.map((p) => `${window.location.origin}${p}`).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions, insecure context); nothing to recover.
    }
  }

  const Icon = copied ? Check : Link2;
  if (compact) {
    return (
      <button type="button" onClick={copy} title={copied ? "Link copied" : label} aria-label={copied ? "Link copied" : label} className="shrink-0 text-fg-muted hover:text-fg">
        <Icon className="size-3.5" aria-hidden="true" />
      </button>
    );
  }
  return (
    <Button type="button" variant="secondary" size="sm" onClick={copy}>
      <Icon className="size-3.5" aria-hidden="true" />
      {copied ? "Link copied" : label}
    </Button>
  );
}
