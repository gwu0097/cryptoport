// A short-lived, in-process cache for live API responses — see ttlCache.test.ts.
// Used for CoinGecko price responses (adapters/coingecko.ts): repeat views
// within the TTL reuse one response instead of each spending a credit, and
// identical requests already in flight share one fetch. Every value carries
// the time it was actually fetched, so pages can caption its real age
// ("priced 40s ago") — a cached price is never shown as if it were live.
// Failures are never cached.

export interface Fetched<T> {
  value: T;
  fetchedAtMs: number;
}

export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<Fetched<T>>;
  size(): number;
}

export function createTtlCache<T>(ttlMs: number, maxEntries = 500, now: () => number = Date.now): TtlCache<T> {
  const done = new Map<string, Fetched<T>>();
  const inFlight = new Map<string, Promise<Fetched<T>>>();
  return {
    size: () => done.size,
    get(key, load) {
      const hit = done.get(key);
      if (hit && now() - hit.fetchedAtMs < ttlMs) return Promise.resolve(hit);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const p = load()
        .then((value) => {
          const entry = { value, fetchedAtMs: now() };
          done.delete(key); // Map order = insertion; re-insert keeps it LRU-ish
          done.set(key, entry);
          while (done.size > maxEntries) done.delete(done.keys().next().value!);
          return entry;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
  };
}
