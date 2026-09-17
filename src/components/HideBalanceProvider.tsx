"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePersistedState } from "./usePersistedState";

// Shared across every page that shows a maskable dollar figure — one
// toggle, one stored preference, so hiding it anywhere hides it everywhere
// the same way a real "privacy mode" would.
const HIDE_BALANCE_KEY = "cryptoport:hideBalance";

interface HideBalanceContextValue {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

const HideBalanceContext = createContext<HideBalanceContextValue | null>(null);

/**
 * One shared privacy-mode toggle for the whole page (mounted once in
 * (app)/layout.tsx, same pattern as JobPollerProvider), not one
 * usePersistedState call per component. Real bug this fixes, reported
 * directly: TotalValuePanel, BlendedChangeCaption, and ValueHistoryChart
 * each used to call usePersistedState(HIDE_BALANCE_KEY, ...) independently
 * — each got its own private useState seeded from localStorage once on
 * mount, so clicking the eye in TotalValuePanel updated *that* component's
 * own number correctly but never told the other two, which kept showing
 * whatever they'd shown since their own mount until a full page reload.
 * A shared context (one usePersistedState call, read via useContext by
 * every consumer) makes toggling the eye anywhere update every masked
 * value on the page immediately, which is what a single visible toggle
 * implies it does.
 */
export function HideBalanceProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = usePersistedState(HIDE_BALANCE_KEY, false);
  // usePersistedState seeds `false` (localStorage isn't available during
  // SSR) and only swaps in the real stored value post-mount — without this,
  // the server-rendered HTML always contains the real number, so anyone
  // who'd turned hiding on would still see it flash on-screen for a beat
  // on every page load/navigation before the effect catches up. Masked
  // until this provider has actually mounted client-side closes that —
  // the safer direction to flash toward for a privacy feature.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  return (
    <HideBalanceContext.Provider value={{ hidden: !mounted || hidden, setHidden }}>
      {children}
    </HideBalanceContext.Provider>
  );
}

/** Reads the shared privacy-mode state — see HideBalanceProvider's own doc
 * comment. Any component showing a raw dollar figure derived from the
 * user's own total (not an individual holding's own market price, which
 * doesn't reveal portfolio size) should mask it via this. */
export function useHideBalance(): HideBalanceContextValue {
  const ctx = useContext(HideBalanceContext);
  if (!ctx) throw new Error("useHideBalance must be used within HideBalanceProvider");
  return ctx;
}
