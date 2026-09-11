// No "server-only" marker here (unlike supabase.ts/queries.ts): this module
// holds no secrets, just a wrapper around a public, unauthenticated Coinbase
// endpoint, and stays plain so extractSpotAmount is unit-testable with
// `node --test` outside of Next's bundler (which is what makes "server-only"
// a no-op; run standalone it throws unconditionally).

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries on 429 with backoff. Small and local rather than importing
 * adapters/http.ts's fetchWithRetry: that file pulls in "server-only",
 * which throws unconditionally outside Next's bundler (see the top-of-file
 * comment) and would break this file's own unit tests. Needed because
 * Coinbase's Exchange API host (api.exchange.coinbase.com — used for the
 * delisting check and 24h stats below) throttles hard: verified live that
 * firing one request per distinct holding ticker concurrently (this file's
 * actual caller, prices.ts's refreshPrices) got 429'd on the large majority
 * of /stats calls, even ones for perfectly ordinary, actively-traded
 * products (TAO, JitoSOL, ATOM) — not a per-product gap, a burst-rate-limit
 * one. prices.ts also caps how many tickers run concurrently for the same
 * reason; this retry is the second, complementary layer for whatever still
 * gets throttled through that.
 */
async function fetchWithRetry(url: string, attempts = 3, baseDelayMs = 500): Promise<Response> {
  let res: Response;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    res = await fetch(url, { cache: "no-store" });
    if (res.status !== 429) return res;
  }
  return res!;
}

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
  const res = await fetchWithRetry(`${EXCHANGE_BASE_URL}/${encodeURIComponent(ticker)}-USD`);
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
  const [res] = await Promise.all([fetchWithRetry(url), assertProductTradable(ticker)]);
  if (!res.ok) {
    throw new Error(`Coinbase ${ticker}-USD spot request failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  return extractSpotAmount(ticker, json);
}

interface CoinbaseStatsResponse {
  open?: string;
  last?: string;
}

/** Percent change from a 24h-stats response's `open` to `last`, or null if
 * either field is missing/unusable — kept separate from the fetch for the
 * same unit-testability reason as extractSpotAmount/isDelistedProduct.
 * Returns null rather than throwing: unlike the spot price itself, this is
 * a display nicety, not something a malformed response should fail the
 * whole ticker's refresh over. */
export function extractPriceChange24h(json: unknown): number | null {
  const stats = json as CoinbaseStatsResponse | null;
  const open = Number(stats?.open);
  const last = Number(stats?.last);
  if (!Number.isFinite(open) || open === 0 || !Number.isFinite(last)) return null;
  return ((last - open) / open) * 100;
}

/** Never throws — a failure here (network, a ticker Coinbase's Exchange
 * API doesn't have stats for) just means no 24h change this refresh, same
 * "one field's failure shouldn't touch the price itself" reasoning as
 * extractPriceChange24h. This is one extra request per Coinbase-priced
 * ticker beyond what fetchCoinbaseSpotPrice/assertProductTradable already
 * make — same public, unauthenticated Exchange API host as the delisting
 * check, no separate rate-limit budget to weigh against. */
export async function fetchCoinbase24hChange(ticker: string): Promise<number | null> {
  try {
    const res = await fetchWithRetry(`${EXCHANGE_BASE_URL}/${encodeURIComponent(ticker)}-USD/stats`);
    if (!res.ok) return null;
    return extractPriceChange24h(await res.json());
  } catch {
    return null;
  }
}
