"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { readRecentWallets, type RecentWallet } from "@/lib/recentWallets";
import { usePersistedState } from "../usePersistedState";

const OPEN_STORAGE_KEY = "cryptoport:recentWalletsOpen";

/**
 * Up to 4 most-recently-viewed wallets, nested under the Wallets nav
 * link — collapsed by default, expanded state remembered (usePersistedState,
 * same "remember the user's last choice" convention as every other
 * persisted UI preference in this app) since there's no reason to re-ask
 * once someone's opened it. Recorded by RecordRecentWallet.tsx (mounted on
 * wallets/[id]/page.tsx) into localStorage, read back here.
 *
 * Re-reads on every `pathname` change rather than once on mount: Sidebar/
 * MobileNav stay mounted across client-side navigations (they live in the
 * shared app layout), so visiting a new wallet updates localStorage
 * without this component ever remounting — a mount-only read would go
 * stale after the very first wallet visited this session.
 */
export function RecentWalletsNav({
  pathname,
  onLinkClick,
}: {
  pathname: string;
  onLinkClick?: () => void;
}) {
  const [wallets, setWallets] = useState<RecentWallet[]>([]);
  const [open, setOpen] = usePersistedState(OPEN_STORAGE_KEY, false);

  useEffect(() => {
    // Synchronizing with an external system (localStorage), not deriving
    // state that could just be computed during render — same exception as
    // usePersistedState.ts's own identical read-on-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWallets(readRecentWallets());
  }, [pathname]);

  if (wallets.length === 0) return null;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:text-fg"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        Recent wallets
      </button>
      {open && (
        <div className="ml-4 flex flex-col gap-0.5 border-l border-border py-0.5 pl-3">
          {wallets.map((w) => {
            const href = `/wallets/${w.id}`;
            const active = pathname === href;
            return (
              <Link
                key={w.id}
                href={href}
                onClick={onLinkClick}
                aria-current={active ? "page" : undefined}
                title={w.name}
                className={`truncate rounded-md px-2 py-1 text-xs transition ${
                  active ? "font-medium text-fg" : "text-fg-muted hover:text-fg"
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
