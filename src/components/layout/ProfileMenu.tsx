"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleUserRound, User, Settings, LogOut } from "lucide-react";
import { signOut } from "@/app/(auth)/actions";

/**
 * Top-right profile menu (next to the signed-in email): Profile (account,
 * password, sign-in wallets), Settings (app preferences), Sign out — the
 * common avatar-menu pattern (GitHub, Slack). Closes on outside click,
 * Escape, or picking an item.
 */
export function ProfileMenu({ userEmail }: { userEmail: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-surface-raised";

  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-2">
      <span className="hidden text-sm text-fg-muted sm:inline">{userEmail}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Profile menu"
        title="Profile"
        className="grid size-9 place-items-center rounded-lg border border-border text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <CircleUserRound className="size-5" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-20 w-48 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <p className="truncate border-b border-border px-3 py-2 text-xs text-fg-muted sm:hidden">{userEmail}</p>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)} className={item}>
            <User className="size-4" aria-hidden="true" /> Profile
          </Link>
          <Link role="menuitem" href="/settings" onClick={() => setOpen(false)} className={item}>
            <Settings className="size-4" aria-hidden="true" /> Settings
          </Link>
          <form action={signOut} className="border-t border-border">
            <button role="menuitem" type="submit" className={item}>
              <LogOut className="size-4" aria-hidden="true" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
