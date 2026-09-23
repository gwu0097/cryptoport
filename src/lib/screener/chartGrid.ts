// Pure — see chartGrid.test.ts. Used by adapters/defillamaPrices.ts.

/** The UTC date of the grid step a /chart point belongs to: the nearest
 * whole number of days from the requested start, not the calendar date of
 * the point's own timestamp. Why (found 2026-09-23 building Phase 4's deep
 * store): DefiLlama jitters point timestamps by about a minute either side
 * of the grid. On a grid near midnight that crosses the date line — a
 * 00:00 grid returned "12-23 23:59", "12-24 23:59", "12-26 00:00"... — so
 * calendar-date labels put about half the points on the previous day,
 * collided with the real previous day, and dropped days (bitcoin: 1,024 of
 * 1,215). The backfill's ~21:31 grid never crossed midnight, which is why
 * it went unnoticed; 2b's 00:00 BTC reference for CoinGecko-priced
 * backfilled rows was affected. Labeling by grid step gives the same dates
 * as before on any grid away from midnight. */
export function chartGridDate(pointEpochSeconds: number, startEpochSeconds: number): string {
  const step = Math.round((pointEpochSeconds - startEpochSeconds) / 86400);
  return new Date((startEpochSeconds + step * 86400) * 1000).toISOString().slice(0, 10);
}
