import "server-only";
import { serviceDb } from "./supabase";
import { postDiscord } from "./adapters/discordWebhook";
import { allow, type Limiter } from "./rateLimit";
import { isAdminEmail } from "./adminEmail";

// Safeguards, not caps (owner 2026-10-02: every feature stays open to every
// user; bot-like use locks that user out at once). Each costly feature counts
// uses per user (or per IP for a signed-out visitor) against a threshold no
// person reaches by clicking; crossing it locks the user out of the costly
// features for LOCK_MS, saved in app_settings (`user_lock:<key>`) so every
// server instance honours it, with a 🚨 Discord line. The owner is never
// locked. Counts are per instance (Vercel runs several): the thresholds are
// per instance, so a spread-out bot still trips one quickly.

export type Feature = "lookup" | "check" | "day" | "tradingRecord" | "backfill" | "coinPrice" | "search" | "perpScout" | "perpScoutPrices";

/** [uses, window] that only a script reaches. */
const THRESHOLDS: Record<Feature, [number, number]> = {
  lookup: [30, 60_000], // 30 address lookups a minute
  check: [30, 60 * 60_000], // 30 Refresh activity clicks an hour (each address is reused for 15 min anyway)
  day: [1_200, 60 * 60_000], // Watch at its fastest is ~240 an hour per tab
  tradingRecord: [30, 60 * 60_000],
  backfill: [10, 60 * 60_000],
  coinPrice: [300, 60 * 60_000],
  search: [60, 60 * 60_000], // Wallet searches
  perpScout: [20, 60 * 60_000], // Perp Scout scans (a scan under 2 min old is reused, one runs at a time)
  perpScoutPrices: [300, 60 * 60_000], // Perp Scout price refreshes (one Hyperliquid call each)
};
const LOCK_MS = 24 * 60 * 60_000;
const LOCK_CACHE_MS = 60_000;

const counts: Limiter = new Map();
const lockCache = new Map<string, { until: number; reason: string; checkedAt: number }>();

const settingKey = (key: string) => `user_lock:${key}`;

async function lockedUntil(key: string): Promise<{ until: number; reason: string } | null> {
  const hit = lockCache.get(key);
  if (hit && Date.now() - hit.checkedAt < LOCK_CACHE_MS) return hit.until > Date.now() ? hit : null;
  const { data } = await serviceDb().from("app_settings").select("value").eq("key", settingKey(key)).maybeSingle();
  const v = (data?.value ?? null) as { until?: string; reason?: string } | null;
  const until = v?.until ? Date.parse(v.until) : 0;
  lockCache.set(key, { until, reason: v?.reason ?? "", checkedAt: Date.now() });
  return until > Date.now() ? { until, reason: v?.reason ?? "" } : null;
}

async function lock(key: string, label: string, reason: string): Promise<void> {
  const until = Date.now() + LOCK_MS;
  lockCache.set(key, { until, reason, checkedAt: Date.now() });
  await serviceDb()
    .from("app_settings")
    .upsert({ key: settingKey(key), value: { until: new Date(until).toISOString(), reason, label }, updated_at: new Date().toISOString() })
    .then(({ error }) => error && console.error(`[abuse-guard] lock not saved: ${error.message}`));
  console.error(`[abuse-guard] locked ${label}: ${reason}`);
  const url = process.env.DISCORD_WATCH_WEBHOOK_URL;
  if (url) await postDiscord(url, `🚨 Locked **${label}** out of costly features for 24 h: ${reason}. Remove the \`${settingKey(key)}\` row in app_settings to unlock early.`, null).catch(() => {});
}

const LOCKED_MESSAGE = "Paused for 24 hours: this account made far more requests than a person does. If that's a mistake, contact the site owner.";

/**
 * One use of a costly feature by `key` (a user id, or `ip:<address>`).
 * `label` names them in the Discord line (an email's local part, or the IP).
 * The owner always passes.
 */
export async function guardUse(feature: Feature, key: string, label: string, isOwner: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isOwner) return { ok: true };
  if (await lockedUntil(key).catch(() => null)) return { ok: false, error: LOCKED_MESSAGE };
  const [limit, windowMs] = THRESHOLDS[feature];
  if (!allow(counts, `${feature}|${key}`, limit, windowMs, Date.now())) {
    await lock(key, label, `${limit}+ ${feature} uses within ${Math.round(windowMs / 60_000)} min`);
    return { ok: false, error: LOCKED_MESSAGE };
  }
  return { ok: true };
}

/** guardUse for a signed-in user (the owner always passes). */
export function guardUser(feature: Feature, user: { id: string; email?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  return guardUse(feature, user.id, (user.email ?? user.id).split("@")[0], isAdminEmail(user.email ?? null, process.env.ADMIN_EMAIL));
}
