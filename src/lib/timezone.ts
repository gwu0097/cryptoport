// Pure display-timezone helpers (see timezone.test.ts). The user picks a
// timezone in Settings → Language & region, or leaves it on Automatic (the
// browser's own zone, sent to the server in a cookie). Every displayed
// instant goes through a formatter that takes the zone explicitly — the
// server runs in UTC, so an implicit zone silently rendered UTC before this.
//
// Only DISPLAY changes. Stored data and computation boundaries (daily
// snapshots, the screener's 07:00 UTC run, Signals' epoch-aligned blocks)
// stay in UTC by design. Calendar dates with no time (e.g. a daily
// snapshot's date) are formatted in UTC on purpose — shifting them into a
// local zone would move the day.

export const TZ_COOKIE = "cryptoport_tz";
export const FALLBACK_TZ = "UTC";

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type TimeZoneSource = "saved" | "detected" | "fallback";

/** saved setting > browser-detected (cookie) > UTC. Invalid values are skipped, never trusted. */
export function resolveTimeZone(
  saved: string | null | undefined,
  detected: string | null | undefined,
): { tz: string; source: TimeZoneSource } {
  if (isValidTimeZone(saved)) return { tz: saved, source: "saved" };
  if (isValidTimeZone(detected)) return { tz: detected, source: "detected" };
  return { tz: FALLBACK_TZ, source: "fallback" };
}

/** Every IANA zone this runtime knows, for the Settings picker. */
export function listTimeZones(): string[] {
  return Intl.supportedValuesOf("timeZone");
}

/** "America/Los_Angeles (PDT, UTC-7)" — a picker label with the zone's current abbreviation and offset. */
export function timeZoneLabel(tz: string, at: Date = new Date()): string {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const parts = [short, offset && offset !== short ? offset.replace("GMT", "UTC") : null].filter(Boolean);
  return parts.length > 0 ? `${tz} (${parts.join(", ")})` : tz;
}

/**
 * The TradingView embed widget accepts only its own list of zones (from
 * TradingView's charting documentation, "supported timezones"); anything
 * else falls back to UTC rather than risk a widget error.
 */
const TRADINGVIEW_ZONES = new Set([
  "Etc/UTC", "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "America/Argentina/Buenos_Aires", "America/Bogota",
  "America/Caracas", "America/Chicago", "America/El_Salvador", "America/Juneau", "America/Lima", "America/Los_Angeles",
  "America/Mexico_City", "America/New_York", "America/Phoenix", "America/Santiago", "America/Sao_Paulo", "America/Toronto",
  "America/Vancouver", "Asia/Almaty", "Asia/Ashkhabad", "Asia/Bahrain", "Asia/Bangkok", "Asia/Chongqing", "Asia/Dubai",
  "Asia/Ho_Chi_Minh", "Asia/Hong_Kong", "Asia/Jakarta", "Asia/Jerusalem", "Asia/Karachi", "Asia/Kathmandu", "Asia/Kolkata",
  "Asia/Kuwait", "Asia/Manila", "Asia/Muscat", "Asia/Qatar", "Asia/Riyadh", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore",
  "Asia/Taipei", "Asia/Tehran", "Asia/Tokyo", "Atlantic/Reykjavik", "Australia/Adelaide", "Australia/Brisbane",
  "Australia/Perth", "Australia/Sydney", "Europe/Amsterdam", "Europe/Athens", "Europe/Belgrade", "Europe/Berlin",
  "Europe/Brussels", "Europe/Copenhagen", "Europe/Dublin", "Europe/Helsinki", "Europe/Istanbul", "Europe/Lisbon",
  "Europe/London", "Europe/Luxembourg", "Europe/Madrid", "Europe/Malta", "Europe/Moscow", "Europe/Oslo", "Europe/Paris",
  "Europe/Riga", "Europe/Rome", "Europe/Stockholm", "Europe/Tallinn", "Europe/Vilnius", "Europe/Warsaw", "Europe/Zurich",
  "Pacific/Auckland", "Pacific/Chatham", "Pacific/Fakaofo", "Pacific/Honolulu", "Pacific/Norfolk",
]);

export function tradingViewTimeZone(tz: string): string {
  if (tz === "UTC") return "Etc/UTC";
  return TRADINGVIEW_ZONES.has(tz) ? tz : "Etc/UTC";
}
