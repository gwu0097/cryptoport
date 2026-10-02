// Deliveries per live address in the last hour, per server instance — what a
// live receiver sees cheaply before suspecting a bot (liveBudget.ts
// SUSPECT_PER_HOUR; the day's count decides). Pure (the clock is passed in).

const HOUR_MS = 60 * 60_000;

export type DeliveryCounter = Map<string, number[]>;

/** Adds `n` deliveries for `address` at `nowMs`; the total within `windowMs`
 * (an hour unless given). */
export function countDeliveries(counter: DeliveryCounter, address: string, nowMs: number, n = 1, windowMs = HOUR_MS): number {
  const recent = (counter.get(address) ?? []).filter((t) => nowMs - t < windowMs);
  for (let i = 0; i < n; i++) recent.push(nowMs);
  counter.set(address, recent);
  return recent.length;
}
