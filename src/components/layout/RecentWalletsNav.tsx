"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { readRecentWallets, RECENT_WALLETS_CHANGED_EVENT, type RecentWallet } from "@/lib/recentWallets";
import { usePersistedState } from "../usePersistedState";
import type { NavItemData } from "./navItems";

/**
 * A nav row (same look as a plain NavLink) plus, only once there's at
 * least one recent entry in `namespace`'s list to show, a chevron on its
 * trailing edge that expands up to 4 of them nested underneath. The
 * disclosure toggle lives on the row it discloses rather than a separate
 * "Recent" label, matching a standard collapsible-tree sidebar. Used for
 * both Wallets (recently-viewed wallet detail pages) and Analytics
 * (recently-selected wallets in its performance-chart picker) — genuinely
 * different histories, see recentWallets.ts's own note on why they're
 * namespaced rather than shared.
 *
 * The chevron is a <button> that's a sibling of the <Link>, not nested
 * inside it — a <button> inside an <a> is invalid HTML (and would fire
 * both the toggle and a navigation on one click). Collapsed by default;
 * expanded state remembered (usePersistedState) since there's no reason
 * to re-ask once someone's opened it.
 *
 * Re-reads `namespace`'s list on every `pathname` change (covers the
 * common case, e.g. visiting a new /wallets/[id]) and also on a
 * same-tab `RECENT_WALLETS_CHANGED_EVENT` (covers Analytics: selecting a
 * wallet in PerformanceChart's combobox records a recent entry without
 * any pathname or route change, since that selection lives in client
 * state, not the URL — a pathname-only read would leave the sidebar
 * showing nothing until the user happened to navigate elsewhere).
 */
export function CollapsibleNavItem({
  item,
  active,
  pathname,
  onLinkClick,
  namespace,
  openStorageKey,
  linkFor,
  isRecentActive,
}: {
  item: NavItemData;
  active: boolean;
  pathname: string;
  onLinkClick?: () => void;
  namespace: string;
  openStorageKey: string;
  linkFor: (recent: RecentWallet) => string;
  /** Whether a given recent entry should render as the currently-active
   * one — omit (pass () => false) when the target page's own selection
   * lives in client state the nav can't see, rather than guess wrong. */
  isRecentActive: (recent: RecentWallet) => boolean;
}) {
  const Icon = item.icon;
  const [recent, setRecent] = useState<RecentWallet[]>([]);
  const [open, setOpen] = usePersistedState(openStorageKey, false);

  useEffect(() => {
    // Synchronizing with an external system (localStorage), not deriving
    // state that could just be computed during render — same exception as
    // usePersistedState.ts's own identical read-on-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecent(readRecentWallets(namespace));

    const onChange = () => setRecent(readRecentWallets(namespace));
    window.addEventListener(RECENT_WALLETS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(RECENT_WALLETS_CHANGED_EVENT, onChange);
  }, [namespace, pathname]);

  const hasRecent = recent.length > 0;

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
            aria-label={open ? `Hide recent ${item.label.toLowerCase()}` : `Show recent ${item.label.toLowerCase()}`}
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
          {recent.map((w) => {
            const walletActive = isRecentActive(w);
            return (
              <Link
                key={w.id}
                href={linkFor(w)}
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
