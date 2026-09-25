// A rolling-window request budget: at most `max` requests in any `windowMs`.
// CoinGecko's free Demo plan allows ~30 calls a minute; a Refresh prices
// fires its CoinGecko lanes in parallel (~50 calls) and a lane died on an
// HTTP 429 (2026-09-25). Pure (no timers, no network).

/** Drops timestamps that have left the window (in place) and returns how
 * long to wait before one more request fits (0 = go now). */
export function windowDelay(recent: number[], nowMs: number, max: number, windowMs: number): number {
  while (recent.length > 0 && recent[0] <= nowMs - windowMs) recent.shift();
  if (recent.length < max) return 0;
  return recent[recent.length - max] + windowMs - nowMs;
}
