"use client";

import { createContext, useContext, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TZ_COOKIE, type TimeZoneSource } from "@/lib/timezone";

const TimeZoneContext = createContext<string>("UTC");
const REFRESHED_KEY = "cryptoport:tzRefreshed";

/** The display timezone for every client component (resolved server-side:
 * saved setting > browser-detected > UTC). */
export function useTimeZone(): string {
  return useContext(TimeZoneContext);
}

/**
 * Provides the resolved zone, and keeps the browser-detected zone in a
 * cookie so the SERVER can render times in it too (it has no other way to
 * know the browser's zone). On a first visit, or after travelling, the
 * cookie is updated and — only if the page is currently rendering on the
 * detected zone — the page refreshes once so server-rendered times match.
 */
export function TimeZoneProvider({
  tz,
  source,
  detected,
  children,
}: {
  tz: string;
  source: TimeZoneSource;
  detected: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  useEffect(() => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browser || browser === detected) return;
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(browser)}; path=/; max-age=31536000; samesite=lax`;
    // A saved setting overrides detection, so nothing on screen changes then.
    if (source === "saved") return;
    // Refresh at most once per session per zone: if cookies are blocked the
    // cookie never sticks, and an unguarded refresh would loop forever.
    try {
      if (sessionStorage.getItem(REFRESHED_KEY) === browser) return;
      sessionStorage.setItem(REFRESHED_KEY, browser);
    } catch {
      return; // no sessionStorage either — don't risk a loop; client-side times are already right
    }
    router.refresh();
  }, [detected, source, router]);

  return <TimeZoneContext.Provider value={tz}>{children}</TimeZoneContext.Provider>;
}
