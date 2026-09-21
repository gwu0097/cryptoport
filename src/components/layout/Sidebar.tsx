"use client";

import { usePathname } from "next/navigation";
import { NavItemsList, SETTINGS_ITEM, ADMIN_ITEM, isActive, NavLink } from "./navItems";

// Below md, this is replaced by MobileNav's drawer (see TopBar.tsx) — not
// shown at all, rather than e.g. collapsing to icons-only, since a phone
// screen doesn't have room for a persistent nav column at any width.
export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  return (
    // sticky top-14 (TopBar's own h-14) + h-[calc(100vh-3.5rem)] pins this
    // under the already-sticky TopBar instead of scrolling away with page
    // content — reported directly: on a long table (Assets), the sidebar
    // (Settings included) scrolled off with everything else, since nothing
    // here previously stopped it from following normal document flow.
    // overflow-y-auto is a defensive cap, not something seen live yet —
    // this nav is short today, but the same reasoning as Dialog.tsx's own
    // height cap applies if it ever grows past a short viewport.
    <nav className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface p-3 md:flex">
      <div className="flex flex-1 flex-col gap-1">
        <NavItemsList pathname={pathname} />
      </div>
      <div className="mt-auto flex flex-col gap-1 pt-3">
        {isAdmin && <NavLink {...ADMIN_ITEM} active={isActive(pathname, ADMIN_ITEM.href)} />}
        <NavLink {...SETTINGS_ITEM} active={isActive(pathname, SETTINGS_ITEM.href)} />
      </div>
    </nav>
  );
}
