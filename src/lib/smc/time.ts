// Pure time formatting for the Signals page (see time.test.ts). Every
// function takes the display timezone explicitly (the user's setting — see
// lib/timezone.ts); an implicit zone would silently render the server's UTC.

const yearIn = (sec: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date(sec * 1000));

/** "Sep 22, 5:00 PM PDT" in the given zone — with the year ("Aug 9, 2025,
 * 5:00 PM PDT") whenever it isn't `nowSec`'s year in that zone, so a signal
 * from a past year can never read as recent. */
export function formatTimeInZone(sec: number, timeZone: string, nowSec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: yearIn(sec, timeZone) === yearIn(nowSec, timeZone) ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(sec * 1000));
}

/** Lightweight Charts' tick kinds (its TickMarkType enum, by value — kept
 * numeric so this file stays free of the charting library). */
export const TICK = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 } as const;

/** A chart-axis label in the given zone, by timeframe. The library places
 * ticks on UTC boundaries, so a "new day" tick lands at e.g. 5 PM in Los
 * Angeles — labeling every tick with its local time made every gridline read
 * "5:00 PM". So: 1D and 4H gridlines show local DATES (with the time only when
 * zoomed in to intraday ticks); 1H gridlines show local TIMES, with the date
 * added on the day/month-boundary ticks so the days stay tellable apart. */
export function formatTickInZone(sec: number, timeZone: string, tickType: number, tf: "1H" | "4H" | "1D"): string {
  const d = new Date(sec * 1000);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone, ...o }).format(d);
  // Month/Year ticks also sit on UTC boundaries (Sep 1 00:00 UTC is Aug 31
  // in Los Angeles), so a bare month name would name the wrong month — they
  // get the local date like any day tick; the year tick adds the year.
  const date = fmt({ month: "short", day: "numeric" });
  const time = fmt({ hour: "numeric" });
  if (tickType === TICK.Year) return fmt({ month: "short", day: "numeric", year: "numeric" });
  if (tickType === TICK.Month || tickType === TICK.DayOfMonth) return tf === "1H" ? `${date}, ${time}` : date;
  return tf === "1H" ? fmt({ hour: "numeric", minute: "2-digit" }) : `${date}, ${time}`;
}

/** "45m", "3h 5m", "2d 4h", "1y 45d" — the coarsest two units. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const y = Math.floor(s / (365 * 86_400));
  if (y > 0) {
    const rd = Math.floor((s - y * 365 * 86_400) / 86_400);
    return rd > 0 ? `${y}y ${rd}d` : `${y}y`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export type Recency = "within_bar" | "within_block" | "within_day" | "older" | "stale";

/** A last signal at least this many of the chart's bars old is flagged stale
 * (30h on 1H, 5d on 4H, 30d on 1D). */
export const STALE_BARS = 30;

/** Whole chart bars between a signal and now. */
export function barsAgo(signalSec: number, nowSec: number, barSeconds: number): number {
  return Math.max(0, Math.floor((nowSec - signalSec) / barSeconds));
}

/** How fresh a signal is, measured in the chart's own bars: within one bar
 * (flash — still actionable), within one block (3 bars), within a day,
 * older, or stale (≥ STALE_BARS bars — flagged so it can't pass as recent). */
export function signalRecency(signalSec: number, nowSec: number, barSeconds: number): Recency {
  const age = nowSec - signalSec;
  if (barsAgo(signalSec, nowSec, barSeconds) >= STALE_BARS) return "stale";
  if (age < barSeconds) return "within_bar";
  if (age < 3 * barSeconds) return "within_block";
  if (age < 86_400) return "within_day";
  return "older";
}
