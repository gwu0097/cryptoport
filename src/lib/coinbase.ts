// No "server-only" marker here (unlike supabase.ts/queries.ts): this module
// holds no secrets, just a wrapper around a public, unauthenticated Coinbase
// endpoint, and stays plain so extractSpotAmount is unit-testable with
// `node --test` outside of Next's bundler (which is what makes "server-only"
// a no-op; run standalone it throws unconditionally).

const BASE_URL = "https://api.coinbase.com/v2/prices";
// The public Exchange API (separate host/shape from the v2 prices endpoint
// above) — used only to check a product's trading status. Its `/products`
// listing is what actually reflects delisting; the v2 spot-price endpoint
// keeps serving a frozen last-traded number for a delisted product with no
// signal in its own response shape that it's stale (verified against
// JUP-USD: still returns 200 with a real-looking "0.000315" amount, but
// /products/JUP-USD says {"status":"delisted","trading_disabled":true} —
// real JUP trades around $0.25 elsewhere).
const EXCHANGE_BASE_URL = "https://api.exchange.coinbase.com/products";

interface CoinbaseSpotResponse {
  data?: { amount?: string };
}

interface CoinbaseProductResponse {
  status?: string;
  trading_disabled?: boolean;
}

/** Pulls the spot amount out of a Coinbase response body, or throws. Kept
 * separate from the fetch so the parsing/validation logic is unit-testable
 * without a network call. */
export function extractSpotAmount(ticker: string, json: unknown): string {
  const amount = (json as CoinbaseSpotResponse | null)?.data?.amount;
  if (typeof amount !== "string" || amount.trim() === "") {
    throw new Error(`Coinbase response for ${ticker} had no usable "data.amount".`);
  }
  return amount;
}

/** True only when Coinbase's own product listing confirms this product is
 * permanently gone (delisted or trading disabled) — kept separate from the
 * fetch for the same unit-testability reason as extractSpotAmount. Not
 * triggered by a missing/malformed response (a 404 for a ticker Coinbase
 * never listed at all is a different, ordinary failure, not a delisting). */
export function isDelistedProduct(json: unknown): boolean {
  const product = json as CoinbaseProductResponse | null;
  return product?.status === "delisted" || product?.trading_disabled === true;
}

/** Distinguishes "Coinbase confirms this product is permanently delisted"
 * from every other failure (network blip, a ticker Coinbase never listed,
 * ...) — see prices.ts's refreshPrices, which only lets a *delisted*
 * failure override its "never let Jupiter overwrite an established
 * Coinbase price" rule (a spam token sharing a real ticker's symbol
 * shouldn't hijack that price just because Coinbase had a bad moment). */
export class CoinbaseDelistedError extends Error {}

async function assertProductTradable(ticker: string): Promise<void> {
  const res = await fetch(`${EXCHANGE_BASE_URL}/${encodeURIComponent(ticker)}-USD`, { cache: "no-store" });
  // A failure here (network, 404 for a ticker Coinbase never listed) isn't
  // evidence of delisting — don't block the price fetch on it, the spot
  // call below is the real source of truth for "does this work at all".
  if (!res.ok) return;
  const json = await res.json();
  if (isDelistedProduct(json)) {
    throw new CoinbaseDelistedError(
      `Coinbase ${ticker}-USD is delisted — its spot price is a frozen last-trade value, not live.`,
    );
  }
}

export async function fetchCoinbaseSpotPrice(ticker: string): Promise<string> {
  const url = `${BASE_URL}/${encodeURIComponent(ticker)}-USD/spot`;
  const [res] = await Promise.all([fetch(url, { cache: "no-store" }), assertProductTradable(ticker)]);
  if (!res.ok) {
    throw new Error(`Coinbase ${ticker}-USD spot request failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  return extractSpotAmount(ticker, json);
}
