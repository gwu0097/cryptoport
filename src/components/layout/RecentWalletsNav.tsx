"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { readRecentWallets, type RecentWallet } from "@/lib/recentWallets";
import { usePersistedState } from "../usePersistedState";
import type { NavItemData } from "./navItems";

const OPEN_STORAGE_KEY = "cryptoport:recentWalletsOpen";

/**
 * The Wallets nav row itself — same look as a plain NavLink — plus, only
 * once there's at least one recently-viewed wallet to show, a chevron on
 * its trailing edge that expands up to 4 of them nested underneath. The
 * disclosure toggle lives on the row it discloses rather than a separate
 * "Recent wallets" label, matching a standard collapsible-tree sidebar.
 *
 * The chevron is a <button> that's a sibling of the <Link>, not nested
 * inside it — a <button> inside an <a> is invalid HTML (and would fire
 * both the toggle and a navigation on one click). Collapsed by default;
 * expanded state remembered (usePersistedState) since there's no reason
 * to re-ask once someone's opened it.
 *
 * Recorded by RecordRecentWallet.tsx (mounted on wallets/[id]/page.tsx)
 * into localStorage. Re-reads on every `pathname` change rather than once
 * on mount: Sidebar/MobileNav (this component's only callers) stay
 * mounted across client-side navigations, so visiting a new wallet
 * updates localStorage without this component ever remounting — a
 * mount-only read would go stale after the first wallet visited.
 */
export function WalletsNavItem({
  item,
  active,
  pathname,
  onLinkClick,
}: {
  item: NavItemData;
  active: boolean;
  pathname: string;
  onLinkClick?: () => void;
}) {
  const Icon = item.icon;
  const [wallets, setWallets] = useState<RecentWallet[]>([]);
  const [open, setOpen] = usePersistedState(OPEN_STORAGE_KEY, false);

  useEffect(() => {
    // Synchronizing with an external system (localStorage), not deriving
    // state that could just be computed during render — same exception as
    // usePersistedState.ts's own identical read-on-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWallets(readRecentWallets());
  }, [pathname]);

  const hasRecent = wallets.length > 0;

  return (
    <div>
      <div
        className={
          "flex items-center rounded-lg border-l-2 transition " +
          (active
            ? "border-accent bg-surface-raised font-medium text-fg"
            : "border-transparent text-fg-muted hover:bg-surface-raised hover:text-fg")
        }
      >
        <Link
          href={item.href}
          onClick={onLinkClick}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-sm"
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {item.label}
        </Link>
        {hasRecent && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={open ? "Hide recent wallets" : "Show recent wallets"}
            className="mr-1 shrink-0 rounded-md p-1.5 text-fg-muted transition hover:bg-surface hover:text-fg"
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {hasRecent && open && (
        <div className="ml-4 flex flex-col gap-0.5 border-l border-border py-1 pl-3">
          {wallets.map((w) => {
            const href = `/wallets/${w.id}`;
            const walletActive = pathname === href;
            return (
              <Link
                key={w.id}
                href={href}
                onClick={onLinkClick}
                aria-current={walletActive ? "page" : undefined}
                title={w.name}
                className={`truncate rounded-md px-2 py-1 text-xs transition ${
                  walletActive ? "font-medium text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                {w.name}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
