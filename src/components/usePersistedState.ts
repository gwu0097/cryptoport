"use client";

import { useEffect, useState } from "react";

/**
 * A piece of client state that remembers its last value in localStorage,
 * keyed by `key` — for small "remember my last choice" UI preferences
 * (table sort, a checked filter) that are genuinely per-browser, not
 * something to sync across devices/accounts. Extracted after this same
 * read-on-mount/write-through/try-catch idiom had already been hand-copied
 * twice (WalletsTable.tsx's sort, WalletButton.tsx's last-used wallet) —
 * see CLAUDE.md's "grep before copying" rule.
 *
 * SSR-safe: seeds with `defaultValue` (localStorage isn't available during
 * server rendering), then rehydrates post-mount inside a useEffect — first
 * paint uses the default, then snaps to whatever was last chosen, same
 * trade-off React's own docs describe for this exact "can't know yet"
 * case. Not the "derive state that could just be computed during render"
 * anti-pattern react-hooks/set-state-in-effect targets — this is
 * synchronizing with an external system (localStorage), which is what
 * effects are for; disabled narrowly rather than restructuring around a
 * lint rule that doesn't fit. Privacy-mode/blocked-storage safe: every
 * read and write is try/catch-wrapped, silently falling back to in-memory
 * state on failure — a blocked localStorage just means the choice applies
 * for this visit only, not an error the user needs to see.
 */
export function usePersistedState<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(defaultValue);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(JSON.parse(stored) as T);
    } catch {
      // corrupt/blocked storage — just keep the default
    }
    // key is a static per-component constant, not something that changes
    // across this component's lifetime — safe to leave out of the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set(next: T) {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // best-effort — nothing to fall back to, the choice still applies
      // this session
    }
  }

  return [value, set];
}
