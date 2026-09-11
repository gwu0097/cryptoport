"use client";

import { Fragment } from "react";
import Link, { useLinkStatus } from "next/link";
import {
  Briefcase,
  Wallet,
  LayoutDashboard,
  ChartLine,
  Coins,
  Layers,
  ArrowLeftRight,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { RecentWalletsNav } from "./RecentWalletsNav";

// Shared between Sidebar.tsx (desktop, always visible) and MobileNav.tsx
// (the phone-width drawer) so the two never drift out of sync — same list,
// same active-path logic, same row styling, just a different container.
export interface NavItemData {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItemData[] = [
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/wallets", label: "Wallets", icon: Wallet },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/assets", label: "Assets", icon: Coins },
  { href: "/analytics", label: "Analytics", icon: ChartLine },
  { href: "/defi", label: "DeFi", icon: Layers },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
];

export const SETTINGS_ITEM: NavItemData = { href: "/settings", label: "Settings", icon: Settings };

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// useLinkStatus must be called from a descendant of <Link>, not the
// component that renders <Link> itself — this is why the icon+label are
// their own nested component rather than inline in NavLink below. Gives an
// immediate (if subtle) reaction to the click itself — a fixed-size,
// always-rendered dot per Next's own guidance on avoiding layout shift —
// on top of (app)/loading.tsx's page-level skeleton, which is the primary
// fix for the actual wait; this is just closing the small gap before that
// Suspense boundary takes over (e.g. a link that hasn't finished
// prefetching yet).
function NavLinkContent({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
      <span
        aria-hidden="true"
        className={
          "ml-auto size-1.5 shrink-0 rounded-full bg-accent transition-opacity " +
          (pending ? "animate-pulse opacity-100" : "opacity-0")
        }
      />
    </>
  );
}

/** `onClick` is only used by MobileNav, to close the drawer on navigation
 * — Sidebar doesn't pass it, and a plain Link with no onClick is fine. */
export function NavLink({
  href,
  label,
  icon,
  active,
  onClick,
}: NavItemData & { active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center gap-3 rounded-lg border-l-2 px-3 py-2 text-sm transition " +
        (active
          ? "border-accent bg-surface-raised font-medium text-fg"
          : "border-transparent text-fg-muted hover:bg-surface-raised hover:text-fg")
      }
    >
      <NavLinkContent icon={icon} label={label} />
    </Link>
  );
}

/**
 * The full nav item list, shared verbatim by Sidebar.tsx and MobileNav.tsx
 * (see this file's own top comment on why the two must never diverge) —
 * nests RecentWalletsNav right after the Wallets link rather than each
 * caller special-casing NAV_ITEMS' map to insert it, which would be
 * exactly the kind of nav-structure duplication that comment exists to
 * prevent. `onLinkClick` is only used by MobileNav, to close the drawer on
 * navigation (recent-wallet links included).
 */
export function NavItemsList({ pathname, onLinkClick }: { pathname: string; onLinkClick?: () => void }) {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <Fragment key={item.href}>
          <NavLink {...item} active={isActive(pathname, item.href)} onClick={onLinkClick} />
          {item.href === "/wallets" && <RecentWalletsNav pathname={pathname} onLinkClick={onLinkClick} />}
        </Fragment>
      ))}
    </>
  );
}
