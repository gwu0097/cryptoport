// "Prices as of" for what a user holds (docs/pricing/PLAN.md: staleness per
// asset). Pure.
//
// Not simply "the oldest price": a coin whose source stopped answering (a
// delisting) keeps its last price and timestamp, and one such coin would
// make the whole caption read "3 days ago" while everything else was priced
// a minute ago. So: when the bulk was priced (the newest), plus the coins
// lagging it by more than STALE_AFTER_MS, named.

export const STALE_AFTER_MS = 60 * 60 * 1000;

export interface PricesAsOf {
  /** When the most recent of the held coins' prices was fetched. */
  newestAt: string | null;
  /** Held coins priced more than an hour before that, oldest first. */
  stale: { label: string; at: string }[];
}

export function pricesAsOf(held: { label: string; at: string | null }[]): PricesAsOf {
  const dated = held.filter((h): h is { label: string; at: string } => !!h.at && Number.isFinite(Date.parse(h.at)));
  if (dated.length === 0) return { newestAt: null, stale: [] };
  const newest = Math.max(...dated.map((h) => Date.parse(h.at)));
  const seen = new Set<string>();
  const stale = dated
    .filter((h) => newest - Date.parse(h.at) > STALE_AFTER_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .filter((h) => (seen.has(h.label) ? false : (seen.add(h.label), true)));
  return { newestAt: new Date(newest).toISOString(), stale };
}

/** Whether one price lags the newest by more than STALE_AFTER_MS. */
export function isStalePrice(at: string | null, newestAt: string | null): boolean {
  if (!at || !newestAt) return false;
  return Date.parse(newestAt) - Date.parse(at) > STALE_AFTER_MS;
}
