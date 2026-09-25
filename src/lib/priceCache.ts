// Sync-time CoinGecko cache (coin_cache for coin ids, token_registry's
// price_usd/price_at for contracts). A sync reuses a price another wallet's
// sync fetched in the last few minutes instead of asking CoinGecko again,
// so a Sync all prices each chain about once, not once per wallet (it was
// ~300 calls per run, 2026-09-25). "Refresh prices" never reads it — that
// action exists to get live prices. Pure (no DB, no network).

/** How old a cached price a sync may use. */
export const SYNC_PRICE_MAX_AGE_MS = 5 * 60 * 1000;

/** A cached price is fresh when it was fetched within maxAgeMs. A fresh
 * entry with a null price means "CoinGecko had no price" — also reused, so
 * an unlisted token isn't re-asked by every wallet. */
export function isFresh(fetchedAt: string | null | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (!fetchedAt) return false;
  const t = new Date(fetchedAt).getTime();
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < maxAgeMs;
}

/** Keys whose cache entry is fresh vs. the ones that still need fetching. */
export function splitByFreshness<K>(
  keys: K[],
  fetchedAtOf: (key: K) => string | null | undefined,
  nowMs: number,
  maxAgeMs: number,
): { fresh: K[]; stale: K[] } {
  const fresh: K[] = [];
  const stale: K[] = [];
  for (const k of keys) (isFresh(fetchedAtOf(k), nowMs, maxAgeMs) ? fresh : stale).push(k);
  return { fresh, stale };
}
