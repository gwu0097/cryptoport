// Whether a Solana address may go live (owner incident 2026-10-02): a raw
// Helius webhook sends — and charges 1 credit for — every transaction that
// touches a watched address, trade or not. One "wallet" that was really a bot
// (~2,857 transactions a minute, none of them trades we keep) used ~577,000
// of the free plan's 1,000,000 monthly credits in a few hours. Pure.

/** More transactions a minute than this is a bot or a program, not a trader
 * to follow live (~430,000 credits a month on its own). The busiest real
 * trader watched, Risk, runs ~6 a minute. */
export const LIVE_MAX_PER_MIN = 10;

/** Transactions a minute from the newest signatures' block times (seconds,
 * newest first); null when there are too few to tell. */
export function txPerMinute(blockTimes: readonly number[]): number | null {
  const t = blockTimes.filter((x) => x > 0);
  if (t.length < 2) return t.length === 0 ? 0 : null;
  const spanMin = (t[0] - t[t.length - 1]) / 60;
  return spanMin <= 0 ? Infinity : t.length / spanMin;
}

/** A month's webhook credits at that rate. */
export const monthlyCredits = (perMin: number) => Math.round(perMin * 60 * 24 * 30);
