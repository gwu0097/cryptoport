"use client";

import type { MouseEvent, ReactNode } from "react";
import { useTokenDrawer } from "./TokenDrawerProvider";

/**
 * A token's name or icon that opens the token drawer — the one link every
 * table uses (owner 2026-10-09: "whenever I click a token in any page").
 * `tokenKey` is the coin's price_key; without one (a perp, an unmapped token)
 * the children render as plain text. Doesn't trigger the row it sits in
 * (Assets' rows expand on click).
 */
export function TokenLink({ tokenKey, children, className = "" }: { tokenKey: string | null | undefined; children: ReactNode; className?: string }) {
  const drawer = useTokenDrawer();
  if (!tokenKey || tokenKey.startsWith("ticker:") || !drawer) return <span className={className}>{children}</span>;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    drawer.openToken(tokenKey);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open(e as unknown as MouseEvent);
      }}
      className={`cursor-pointer hover:text-accent hover:underline ${className}`}
      title="Open token details"
    >
      {children}
    </span>
  );
}
