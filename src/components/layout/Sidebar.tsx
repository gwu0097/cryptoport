"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/wallets", label: "Wallets", icon: Wallet },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/assets", label: "Assets", icon: Coins },
  { href: "/analytics", label: "Analytics", icon: ChartLine },
  { href: "/defi", label: "DeFi", icon: Layers },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
];

const SETTINGS_ITEM = { href: "/settings", label: "Settings", icon: Settings };

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
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

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface p-3 md:flex">
      <div className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavItem key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
      </div>
      <div className="mt-auto pt-3">
        <NavItem {...SETTINGS_ITEM} active={isActive(pathname, SETTINGS_ITEM.href)} />
      </div>
    </nav>
  );
}
