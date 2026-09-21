"use client";

import Link, { useLinkStatus } from "next/link";
import {
  Briefcase,
  Wallet,
  LayoutDashboard,
  ChartLine,
  Coins,
  Layers,
  ArrowLeftRight,
  GitCompare,
  Settings,
  ShieldCheck,
  Star,
  TrendingUp,
  BookOpen,
  type LucideIcon,
} from "lucide-react";
import { CollapsibleNavItem } from "./RecentWalletsNav";

// Shared between Sidebar.tsx (desktop, always visible) and MobileNav.tsx
// (the phone-width drawer) so the two never drift out of sync — same list,
// same active-path logic, same row styling, just a different container.
export interface NavItemData {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Grouped rather than one flat 11-item list — reported directly as "too
// many tabs jammed together." Portfolio = everything about what you
// actually own (drill-down pages included); Research = market-
// intelligence tools that aren't tied to your specific holdings. Picked
// over a finer 3-way split (Overview/Holdings/Research) via a side-by-side
// preview comparison — this one keeps the mental model to two questions
// ("is this about my money, or the market") instead of three.
export const NAV_GROUPS: { label: string; items: NavItemData[] }[] = [
  {
    label: "Portfolio",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/portfolio", label: "Portfolio", icon: Briefcase },
      { href: "/wallets", label: "Wallets", icon: Wallet },
      { href: "/assets", label: "Assets", icon: Coins },
      { href: "/analytics", label: "Analytics", icon: ChartLine },
      { href: "/defi", label: "DeFi", icon: Layers },
      { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
    ],
  },
  {
    label: "Research",
    items: [
      { href: "/watchlist", label: "Watchlist", icon: Star },
      { href: "/trend-finder", label: "Trend Finder", icon: TrendingUp },
      { href: "/compare", label: "Compare", icon: GitCompare },
      { href: "/encyclopedia", label: "Encyclopedia", icon: BookOpen },
    ],
  },
];

export const SETTINGS_ITEM: NavItemData = { href: "/settings", label: "Settings", icon: Settings };

// Never added to NAV_ITEMS (that array has no per-viewer conditionality at
// all) — Sidebar.tsx/MobileNav.tsx each render this themselves, gated on
// the `isAdmin` boolean layout.tsx computes server-side and passes down.
// The boolean itself is the only thing that crosses into these client
// components — ADMIN_EMAIL never does. This is a convenience (a non-admin
// no chart shows a dead link) — src/lib/adminAuth.ts's requireAdmin() on
// the routes themselves is the actual security boundary.
export const ADMIN_ITEM: NavItemData = { href: "/admin", label: "Admin", icon: ShieldCheck };

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

function NavItemRow({
  item,
  pathname,
  onLinkClick,
}: {
  item: NavItemData;
  pathname: string;
  onLinkClick?: () => void;
}) {
  if (item.href === "/wallets") {
    return (
      <CollapsibleNavItem
        item={item}
        active={isActive(pathname, item.href)}
        pathname={pathname}
        onLinkClick={onLinkClick}
        namespace="wallets"
        openStorageKey="cryptoport:recentWalletsOpen"
        linkFor={(w) => `/wallets/${w.id}`}
        isRecentActive={(w) => pathname === `/wallets/${w.id}`}
      />
    );
  }
  if (item.href === "/analytics") {
    return (
      <CollapsibleNavItem
        item={item}
        active={isActive(pathname, item.href)}
        pathname={pathname}
        onLinkClick={onLinkClick}
        namespace="analyticsWallets"
        openStorageKey="cryptoport:recentAnalyticsWalletsOpen"
        linkFor={(w) => `/analytics?wallet=${w.id}`}
        // Analytics' own wallet selection lives in PerformanceChart's
        // client state, not observable from here — no honest way to
        // tell which recent entry (if any) is "active" from the nav
        // alone, so this never highlights one rather than guessing.
        isRecentActive={() => false}
      />
    );
  }
  if (item.href === "/transactions") {
    return (
      <CollapsibleNavItem
        item={item}
        active={isActive(pathname, item.href)}
        pathname={pathname}
        onLinkClick={onLinkClick}
        namespace="transactionsWallets"
        openStorageKey="cryptoport:recentTransactionsWalletsOpen"
        linkFor={(w) => `/transactions?wallet=${w.id}`}
        // Transactions' wallet selection is a real ?wallet= query
        // param (unlike Analytics' client-state one), but `pathname`
        // here is path-only — no search params threaded through
        // Sidebar/MobileNav to compare against. Same honest
        // "can't tell from here, don't guess" call as Analytics
        // rather than plumbing searchParams through two more
        // components just for this highlight.
        isRecentActive={() => false}
      />
    );
  }
  return <NavLink {...item} active={isActive(pathname, item.href)} onClick={onLinkClick} />;
}

/**
 * The full nav item list, shared verbatim by Sidebar.tsx and MobileNav.tsx
 * (see this file's own top comment on why the two must never diverge) —
 * renders NAV_GROUPS as labeled sections (a plain muted heading, not
 * collapsible — every item stays one click away, this is purely visual
 * chunking, see that array's own doc comment for why grouped at all).
 * Wallets/Analytics/Transactions still render via CollapsibleNavItem (same
 * row, plus a recent-wallets disclosure chevron each, in their own
 * namespace — see recentWallets.ts) instead of the plain NavLink every
 * other item gets — unchanged by grouping, just moved into NavItemRow so
 * the per-item branching isn't duplicated across two group loops.
 * `onLinkClick` is only used by MobileNav, to close the drawer on
 * navigation (recent-wallet links included).
 */
export function NavItemsList({ pathname, onLinkClick }: { pathname: string; onLinkClick?: () => void }) {
  return (
    <>
      {NAV_GROUPS.map((group, i) => (
        <div key={group.label} className={i === 0 ? undefined : "mt-4"}>
          <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted/70">
            {group.label}
          </p>
          <div className="flex flex-col gap-1">
            {group.items.map((item) => (
              <NavItemRow key={item.href} item={item} pathname={pathname} onLinkClick={onLinkClick} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
