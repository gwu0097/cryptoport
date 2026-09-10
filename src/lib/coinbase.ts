// No "server-only" marker here (unlike supabase.ts/queries.ts): this module
// holds no secrets, just a wrapper around a public, unauthenticated Coinbase
// endpoint, and stays plain so extractSpotAmount is unit-testable with
// `node --test` outside of Next's bundler (which is what makes "server-only"
// a no-op; run standalone it throws unconditionally).

const BASE_URL = "https://api.coinbase.com/v2/prices";

interface CoinbaseSpotResponse {
  data?: { amount?: string };
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

export async function fetchCoinbaseSpotPrice(ticker: string): Promise<string> {
  const url = `${BASE_URL}/${encodeURIComponent(ticker)}-USD/spot`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Coinbase ${ticker}-USD spot request failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  return extractSpotAmount(ticker, json);
}
