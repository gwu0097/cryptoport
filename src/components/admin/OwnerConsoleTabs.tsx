"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Owner's console features, one tab each (KOL suggestions: docs/wallet-watch/DIRECTORY.md). Users stays active while viewing
 * a user (/admin/users/<id>/…). A new feature is a route under /admin plus
 * an entry here. */
const TABS = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/apis", label: "API list" },
  { href: "/admin/pricing", label: "Pricing coverage" },
  { href: "/admin/suggestions", label: "KOL suggestions" },
] as const;

export function OwnerConsoleTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Owner's console" className="mb-5 flex flex-wrap gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
              active ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
