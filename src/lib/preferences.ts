import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { userDb } from "./supabase";
import { getUser } from "./auth";
import { resolveTimeZone, TZ_COOKIE, type TimeZoneSource } from "./timezone";

/** The signed-in user's saved preferences row (null for guests / no row yet). Deduped per request. */
export const getUserPreferences = cache(async (): Promise<{ timezone: string | null } | null> => {
  if (!(await getUser())) return null;
  const db = await userDb();
  const { data, error } = await db.from("user_preferences").select("timezone").maybeSingle();
  if (error) throw new Error(`Failed to load user preferences: ${error.message}`);
  return data ?? { timezone: null };
});

export interface EffectiveTimeZone {
  tz: string;
  source: TimeZoneSource;
  /** The saved setting itself (null = Automatic). */
  saved: string | null;
  /** The browser-detected zone from the cookie, if the client has set it yet. */
  detected: string | null;
}

/** The zone every displayed time uses: saved setting > browser-detected (cookie) > UTC. Deduped per request. */
export const getEffectiveTimeZone = cache(async (): Promise<EffectiveTimeZone> => {
  const [prefs, jar] = await Promise.all([getUserPreferences(), cookies()]);
  const saved = prefs?.timezone ?? null;
  const detected = jar.get(TZ_COOKIE)?.value ?? null;
  return { ...resolveTimeZone(saved, detected), saved, detected };
});
