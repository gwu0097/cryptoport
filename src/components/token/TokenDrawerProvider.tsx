"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { TokenDrawer } from "./TokenDrawer";

/**
 * The token drawer (owner 2026-10-09): click a token anywhere and a panel
 * slides in from the right with its overview — which of your wallets hold it,
 * its contracts, a chart. One drawer for the whole app, mounted in the app
 * layout; any token link opens it (TokenLink). Plain state, not the URL: a
 * `?token=` param fought the pages that build their own filter links from the
 * query string. It closes on Esc, the backdrop, or going to another page.
 */
const Ctx = createContext<{ openToken: (key: string) => void } | null>(null);

export function TokenDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ key: string; path: string } | null>(null);
  const pathname = usePathname();
  const openToken = useCallback((key: string) => setOpen({ key, path: window.location.pathname }), []);
  const close = useCallback(() => setOpen(null), []);
  // Another page: the drawer belonged to the one you left — cleared during
  // render (React's pattern for state that follows a prop), so it doesn't
  // reappear if you come back.
  if (open && open.path !== pathname) setOpen(null);
  const key = open && open.path === pathname ? open.key : null;

  return (
    <Ctx.Provider value={{ openToken }}>
      {children}
      {key && <TokenDrawer tokenKey={key} onClose={close} />}
    </Ctx.Provider>
  );
}

/** Opens the token drawer; null outside the provider (guest pages). */
export function useTokenDrawer() {
  return useContext(Ctx);
}
