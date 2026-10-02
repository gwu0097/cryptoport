// Deliveries per live address in the last hour, per server instance — what a
// live receiver sees cheaply before suspecting a bot (liveBudget.ts
// SUSPECT_PER_HOUR; the day's count decides). Kept in 10-second buckets (at
// most 360 an hour per address): one timestamp per delivery held 100K+
// entries per address in a flood and was scanned on every delivery (audit
// 2026-10-02). Pure (the clock is passed in).

const HOUR_MS = 60 * 60_000;
const BUCKET_MS = 10_000;

/** Per address: [bucket start ms, deliveries] oldest first. */
export type DeliveryCounter = Map<string, [number, number][]>;

/** Adds `n` deliveries for `address` at `nowMs`; the total within `windowMs`
 * (an hour unless given; whole buckets, so to the nearest 10 s). */
export function countDeliveries(counter: DeliveryCounter, address: string, nowMs: number, n = 1, windowMs = HOUR_MS): number {
  const bucket = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
  const buckets = (counter.get(address) ?? []).filter(([b]) => nowMs - b < Math.max(windowMs, HOUR_MS));
  const last = buckets.at(-1);
  if (last && last[0] === bucket) last[1] += n;
  else if (n > 0) buckets.push([bucket, n]);
  counter.set(address, buckets);
  return buckets.reduce((s, [b, c]) => (nowMs - b < windowMs ? s + c : s), 0);
}
