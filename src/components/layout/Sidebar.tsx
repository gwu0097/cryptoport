"use client";

import { usePathname } from "next/navigation";
import { NavItemsList, SETTINGS_ITEM, ADMIN_ITEM, isActive, NavLink } from "./navItems";

// Below md, this is replaced by MobileNav's drawer (see TopBar.tsx) — not
// shown at all, rather than e.g. collapsing to icons-only, since a phone
// screen doesn't have room for a persistent nav column at any width.
export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  return (
    // Pinned under the sticky TopBar (top-14 = its h-14) at exactly the rest
    // of the viewport's height, so it never scrolls away with a long page
    // (reported: on Assets, Settings scrolled off with the table). Inside,
    // the standard app-sidebar layout: the links are their own scroll area
    // (min-h-0 lets the flex child shrink below its content and scroll) and
    // Admin/Settings stay pinned at the bottom — the list scrolls
    // independently of the page, only when it doesn't fit. dvh, not vh: the
    // dynamic viewport excludes mobile browser toolbars.
    <nav className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-3">
        <NavItemsList pathname={pathname} />
      </div>
      <div className="flex shrink-0 flex-col gap-1 border-t border-border p-3">
        {isAdmin && <NavLink {...ADMIN_ITEM} active={isActive(pathname, ADMIN_ITEM.href)} />}
        <NavLink {...SETTINGS_ITEM} active={isActive(pathname, SETTINGS_ITEM.href)} />
      </div>
    </nav>
  );
}
