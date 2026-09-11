"use client";

import { usePathname } from "next/navigation";
import { NavItemsList, SETTINGS_ITEM, isActive, NavLink } from "./navItems";

// Below md, this is replaced by MobileNav's drawer (see TopBar.tsx) — not
// shown at all, rather than e.g. collapsing to icons-only, since a phone
// screen doesn't have room for a persistent nav column at any width.
export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface p-3 md:flex">
      <div className="flex flex-1 flex-col gap-1">
        <NavItemsList pathname={pathname} />
      </div>
      <div className="mt-auto pt-3">
        <NavLink {...SETTINGS_ITEM} active={isActive(pathname, SETTINGS_ITEM.href)} />
      </div>
    </nav>
  );
}
