import Link from "next/link";
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

/** `onClick` is only used by MobileNav, to close the drawer on navigation
 * — Sidebar doesn't pass it, and a plain Link with no onClick is fine. */
export function NavLink({
  href,
  label,
  icon: Icon,
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
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </Link>
  );
}
