// Pure time formatting for the Signals page (see time.test.ts). Times show
// in Pacific time — reported directly: "UTC is useless for me". The timezone
// is always explicit (America/Los_Angeles, DST-aware -> PDT/PST), so server
// and browser render the same thing regardless of where they run.

const PT = "America/Los_Angeles";

const ptFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PT,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** "Sep 22, 5:00 PM PDT" */
export function formatPt(sec: number): string {
  return ptFormatter.format(new Date(sec * 1000));
}

const ptAxisTime = new Intl.DateTimeFormat("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit" });
const ptAxisDay = new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "short", day: "numeric" });

/** Short label for a chart's time axis, in PT: the date at PT midnight, else the time. */
export function formatPtAxis(sec: number): string {
  const d = new Date(sec * 1000);
  const time = ptAxisTime.format(d);
  return time === "12:00 AM" ? ptAxisDay.format(d) : time;
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
