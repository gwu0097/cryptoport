// Pure time formatting for the Signals page (see time.test.ts). Every
// function takes the display timezone explicitly (the user's setting — see
// lib/timezone.ts); an implicit zone would silently render the server's UTC.

/** "Sep 22, 5:00 PM PDT" in the given zone. */
export function formatTimeInZone(sec: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(sec * 1000));
}

/** Short chart-axis label in the given zone: the date at local midnight, else the time. */
export function formatAxisInZone(sec: number, timeZone: string): string {
  const d = new Date(sec * 1000);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  return time === "12:00 AM" ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d) : time;
}

/** "45m", "3h 5m", "2d 4h" — the coarsest two units. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export type Recency = "within_bar" | "within_block" | "within_day" | "older";

/** How fresh a signal is, measured in the chart's own bars: within one bar
 * (flash — still actionable), within one block (3 bars), within a day, older. */
export function signalRecency(signalSec: number, nowSec: number, barSeconds: number): Recency {
  const age = nowSec - signalSec;
  if (age < barSeconds) return "within_bar";
  if (age < 3 * barSeconds) return "within_block";
  if (age < 86_400) return "within_day";
  return "older";
}
