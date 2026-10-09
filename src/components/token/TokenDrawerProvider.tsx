"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { TokenDrawer } from "./TokenDrawer";

/**
 * The token drawer (owner 2026-10-09): click a token anywhere and a panel
 * slides in from the right with its overview — which of your wallets hold it,
 * its contracts, a chart. One drawer for the whole app, mounted in the app
 * layout; any token link opens it (TokenLink). The URL carries `?token=<key>`
 * (shareable, and Back closes it) through the browser's own history — no
 * navigation, so the page underneath never re-renders.
 */
const Ctx = createContext<{ openToken: (key: string) => void } | null>(null);

const PARAM = "token";

export function TokenDrawerProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);

  // Open from the URL on load, and follow Back/Forward.
  useEffect(() => {
    const sync = () => setKey(new URLSearchParams(window.location.search).get(PARAM));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const openToken = useCallback((k: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, k);
    // A token opened from inside the drawer replaces it; Back still closes.
    if (url.searchParams.get(PARAM) && new URLSearchParams(window.location.search).get(PARAM)) window.history.replaceState(window.history.state, "", url);
    else {
      window.history.pushState(window.history.state, "", url);
      setPushed(true);
    }
    setKey(k);
  }, []);

  const close = useCallback(() => {
    if (pushed) {
      setPushed(false);
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(PARAM);
    window.history.replaceState(window.history.state, "", url);
    setKey(null);
  }, [pushed]);

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
