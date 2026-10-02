// Whether an address may be live (owner incident 2026-10-02): a live webhook
// sends — and Helius charges 1 credit for — every transaction that touches a
// watched address, trade or not. One "wallet" that was really a bot (over
// 10,000 transactions in its newest hour, none a trade we keep) used ~577,000
// of the free plan's 1,000,000 monthly credits in hours. Judged on a whole
// day, not a minute (owner: traders trade in bursts, then stop): measured
// 2026-10-02, the busiest real trader watched (Risk) made 3,577 in 24 hours,
// its busiest hour 646; the bot passed 10,000 within an hour. Pure.

/** More transactions than this in 24 hours is a bot or an exchange, not a
 * trader to follow live (~300,000 credits a month on its own). */
export const LIVE_DAY_MAX = 10_000;

/** A receiver seeing this many deliveries for one address within an hour
 * checks its day (Risk's busiest hour: 646). */
export const SUSPECT_PER_HOUR = 2_000;

/** Fast stops (owner 2026-10-02: one that turns into a bot is stopped at
 * once, no day check): trades (swaps) in a minute — no person makes 60 —
 * and any transactions in a minute (spam lands beside trades: Risk's burst
 * was ~100 a minute; the bot ~2,900). */
export const STOP_TRADES_PER_MIN = 60;
export const STOP_TX_PER_MIN = 600;

/** Transactions in the 24 hours before `nowSec`, from block times (seconds);
 * `complete` = the read reached back past 24 hours (else the count is a floor). */
export function dayCount(blockTimes: readonly number[], nowSec: number, complete: boolean): { count: number; overLimit: boolean } {
  const count = blockTimes.filter((t) => t > 0 && t >= nowSec - 86_400).length;
  return { count, overLimit: count > LIVE_DAY_MAX || (!complete && count >= LIVE_DAY_MAX) };
}

/** A month's webhook credits at a day's count. */
export const monthlyCredits = (perDay: number) => Math.round(perDay * 30);
