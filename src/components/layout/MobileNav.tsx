"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NavItemsList, SETTINGS_ITEM, ADMIN_ITEM, isActive, NavLink } from "./navItems";

/**
 * The phone-width replacement for Sidebar.tsx, which is `hidden` below
 * `md` with nothing standing in for it — below that width there was
 * previously no way to reach any page except /wallets and whatever the
 * current page happened to link to. A hamburger button in TopBar (this
 * component, `md:hidden`) opens a left-anchored drawer with the same
 * NAV_GROUPS/SETTINGS_ITEM list Sidebar renders, so the two can't drift out
 * of sync.
 *
 * Not built on ui/Dialog.tsx's native <dialog> — that shell is a centered
 * modal (fixed inset-0 m-auto), the wrong shape for a full-height
 * side-anchored drawer, so this is a plain fixed-position overlay instead.
 */
export function MobileNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Locks background scroll while the drawer is open — without it, the
  // page underneath still scrolls with the drawer's backdrop, which reads
  // as broken on a touch screen where that's the main scroll gesture.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-fg-muted hover:bg-surface-raised hover:text-fg md:hidden"
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>

      {open && (
        // h-dvh: the dynamic viewport height, so iOS Safari's toolbars never
        // hide the bottom of the drawer.
        <div className="fixed inset-x-0 top-0 z-40 h-dvh md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          {/* Same layout as Sidebar.tsx: header pinned, the links scroll on
              their own (min-h-0 + overflow-y-auto; overscroll-contain so the
              scroll doesn't chain to the page), Admin/Settings pinned at the
              bottom above the iPhone home indicator. The drawer used to have
              no scroll area, so links below the screen's height couldn't be
              reached (reported 2026-09-26). */}
          <nav className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col border-r border-border bg-surface">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <span className="text-sm font-semibold tracking-tight text-fg">
                Crypto<span className="text-accent">Port</span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-3 pb-3">
              <NavItemsList pathname={pathname} onLinkClick={() => setOpen(false)} />
            </div>
            <div className="flex shrink-0 flex-col gap-1 border-t border-border px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {isAdmin && (
                <NavLink {...ADMIN_ITEM} active={isActive(pathname, ADMIN_ITEM.href)} onClick={() => setOpen(false)} />
              )}
              <NavLink
                {...SETTINGS_ITEM}
                active={isActive(pathname, SETTINGS_ITEM.href)}
                onClick={() => setOpen(false)}
              />
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
