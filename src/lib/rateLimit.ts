// A per-key request limit in a fixed window (owner 2026-10-02: features stay
// open to every user — limits only stop spam and bot-like use, set well above
// normal clicking). Per server instance; the costly ones also keep a durable
// count (api/wallet-watch/check's daily Solana budget). Pure (clock passed in).

export type Limiter = Map<string, { start: number; count: number }>;

/** Counts one use of `key`; false once `limit` uses are reached within
 * `windowMs` (the window starts at the key's first use). */
export function allow(limiter: Limiter, key: string, limit: number, windowMs: number, nowMs: number): boolean {
  const cur = limiter.get(key);
  if (!cur || nowMs - cur.start >= windowMs) {
    limiter.set(key, { start: nowMs, count: 1 });
    if (limiter.size > 5_000) for (const [k, v] of limiter) if (nowMs - v.start >= windowMs) limiter.delete(k); // keep it small
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count++;
  return true;
}
