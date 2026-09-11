"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NAV_ITEMS, SETTINGS_ITEM, isActive, NavLink } from "./navItems";

/**
 * The phone-width replacement for Sidebar.tsx, which is `hidden` below
 * `md` with nothing standing in for it — below that width there was
 * previously no way to reach any page except /wallets and whatever the
 * current page happened to link to. A hamburger button in TopBar (this
 * component, `md:hidden`) opens a left-anchored drawer with the same
 * NAV_ITEMS/SETTINGS_ITEM list Sidebar renders, so the two can't drift out
 * of sync.
 *
 * Not built on ui/Dialog.tsx's native <dialog> — that shell is a centered
 * modal (fixed inset-0 m-auto), the wrong shape for a full-height
 * side-anchored drawer, so this is a plain fixed-position overlay instead.
 */
export function MobileNav() {
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
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <nav className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col gap-1 border-r border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between px-1">
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
            <div className="flex flex-1 flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.href}
                  {...item}
                  active={isActive(pathname, item.href)}
                  onClick={() => setOpen(false)}
                />
              ))}
            </div>
            <div className="mt-auto pt-3">
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
