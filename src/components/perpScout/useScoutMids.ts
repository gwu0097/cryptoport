"use client";

import { useCallback, useEffect, useState } from "react";
import { PRICES_REFRESHED_EVENT } from "@/components/priceEvents";

export interface ScoutMids {
  /** Current mids from Refresh prices; null = the scan's marks. */
  mids: Record<string, number> | null;
  at: number | null;
  pricing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Back to the scan's marks (after a read that's newer than the mids). */
  clear: () => void;
}

/**
 * Perp Scout's Refresh prices (api/perp-scout/prices: one allMids call, not
 * stored), shared by the panels that show it. `listen` also refreshes when
 * the app's own Refresh prices finishes (the Dashboard's button).
 */
export function useScoutMids(listen = false): ScoutMids {
  const [state, setState] = useState<{ mids: Record<string, number>; at: number } | null>(null);
  const [pricing, setPricing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPricing(true);
    setError(null);
    try {
      const res = await fetch("/api/perp-scout/prices", { method: "POST", cache: "no-store" });
      const body = (await res.json()) as { at?: number; mids?: Record<string, number>; error?: string };
      if (!res.ok || !body.mids || !body.at) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState({ at: body.at, mids: body.mids });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPricing(false);
    }
  }, []);

  useEffect(() => {
    if (!listen) return;
    const on = () => void refresh();
    window.addEventListener(PRICES_REFRESHED_EVENT, on);
    return () => window.removeEventListener(PRICES_REFRESHED_EVENT, on);
  }, [listen, refresh]);

  const clear = useCallback(() => setState(null), []);
  return { mids: state?.mids ?? null, at: state?.at ?? null, pricing, error, refresh, clear };
}
