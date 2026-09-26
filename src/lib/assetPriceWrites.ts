// What a pricing pass writes to asset_prices (docs/pricing/PLAN.md). Pure.
//
// The rule that must never break: a key a source didn't return keeps its
// last price. `/coins/markets` omits renamed ids and truncated batches; an
// outage returns nothing — none of that is "no price". A null would flip
// holdings to unpriced and be baked into that day's portfolio snapshot, so
// a missing key only gets last_attempt_at / missing_since / last_error.

export interface FetchedPrice {
  usd: number;
  change_1h?: number | null;
  change_24h?: number | null;
  change_7d?: number | null;
  change_30d?: number | null;
  market_cap?: number | null;
  volume_24h?: number | null;
  source: string;
}

export type PriceWrite =
  | ({ price_key: string; updated_at: string; last_attempt_at: string; missing_since: null; last_error: null } & FetchedPrice)
  | { price_key: string; last_attempt_at: string; missing_since: string; last_error: string };

export function planPriceWrites(
  keys: string[],
  fetched: ReadonlyMap<string, FetchedPrice>,
  errors: ReadonlyMap<string, string>,
  missingSince: ReadonlyMap<string, string | null>,
  nowIso: string,
): PriceWrite[] {
  return [...new Set(keys)].map((price_key) => {
    const p = fetched.get(price_key);
    if (p && Number.isFinite(p.usd) && p.usd > 0) {
      return { price_key, ...p, updated_at: nowIso, last_attempt_at: nowIso, missing_since: null, last_error: null };
    }
    return {
      price_key,
      last_attempt_at: nowIso,
      missing_since: missingSince.get(price_key) ?? nowIso,
      last_error: errors.get(price_key) ?? "not returned by its source",
    };
  });
}

/** The source a key is priced from — one per key, by its namespace. */
export function sourceOf(priceKey: string): "coingecko" | "jupiter" | "hyperliquid" | "coinbase" | "lighter" | "fiat" {
  if (priceKey.startsWith("fiat:")) return "fiat";
  if (priceKey.startsWith("jup:")) return "jupiter";
  if (priceKey.startsWith("hl:") || priceKey.startsWith("hlperp:")) return "hyperliquid"; // spot token / perp mark (perpPositions.ts)
  if (priceKey.startsWith("coinbase:")) return "coinbase";
  if (priceKey.startsWith("lighterperp:")) return "lighter"; // a Lighter perp's mark (perpPositions.ts)
  return "coingecko";
}
