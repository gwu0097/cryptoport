import "server-only";
import { createHmac } from "node:crypto";
import { fetchWithRetry } from "./http";
import { resolveTickerIcons } from "./coingecko";
import type { AdapterHolding } from "./types";

const API_HOST = "https://api.mexc.com";
const ACCOUNT_PATH = "/api/v3/account";

// Same fiat-icon trap already found live for Coinbase/Kraken/Gemini — never
// sent to resolveTickerIcons. MEXC is crypto-only (no fiat on-ramp
// balances observed), kept for parity/safety rather than because it's
// been seen to fire here.
const FIAT_TICKERS = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"]);

interface MexcBalance {
  asset: string;
  free: string;
  locked: string;
}

interface MexcAccountResponse {
  balances: MexcBalance[];
}

/**
 * A user-generated API key with the "SPOT_ACCOUNT_READ" permission only
 * (mexcdevelop.github.io/apidocs/spot_v3_en, live-verified) — no trading or
 * withdrawal scope needed, same "narrowest read-only role" choice already
 * made for Coinbase/Kraken/Gemini.
 *
 * Signing: Binance-API-compatible (MEXC's own docs describe it the same
 * way) — hex(HMAC-SHA256(queryString, key=apiSecret)), where queryString is
 * every param (here just timestamp) in the exact order sent, with the
 * resulting `signature` appended as the last query param. Sent as a GET
 * with the API key in the `X-MEXC-APIKEY` header, never in the query
 * string itself.
 *
 * MEXC's own docs note a key created with no IP allowlist is valid for 90
 * days, then needs regenerating — this app has no static outbound IP to
 * allowlist against (a normal Vercel serverless deployment), so this is
 * surfaced as a setup-step caption (exchangeProviders.ts) rather than
 * something worked around here; same "the exchange's own tradeoff, tell
 * the user honestly" choice as every other provider's own caveats.
 */
export async function fetchMexcBalances(
  apiKey: string,
  apiSecret: string,
): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const query = `timestamp=${Date.now()}`;
  const signature = createHmac("sha256", apiSecret).update(query).digest("hex");

  const res = await fetchWithRetry(`${API_HOST}${ACCOUNT_PATH}?${query}&signature=${signature}`, {
    headers: { "X-MEXC-APIKEY": apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "MEXC rejected this key — double check it has at least Spot Account read permission and hasn't expired (keys without an IP allowlist expire after 90 days).",
      );
    }
    throw new Error(`MEXC balances request failed: HTTP ${res.status} ${body}`);
  }

  const account: MexcAccountResponse = await res.json();
  const holdings: AdapterHolding[] = [];
  for (const b of account.balances) {
    const qty = Number(b.free) + Number(b.locked);
    if (!Number.isFinite(qty) || qty === 0) continue;
    holdings.push({
      ticker: b.asset.toUpperCase(),
      qty,
      usd_override: null, // priced from asset_prices by its price_key (exchange_assets maps the ticker), same as Coinbase/Kraken/Gemini's spot balances
      contract: null,
      category: "token",
      chain: "mexc",
      icon_url: null, // filled in below via resolveTickerIcons
    });
  }

  const iconTickers = holdings.map((h) => h.ticker).filter((t) => !FIAT_TICKERS.has(t));
  const icons = await resolveTickerIcons(iconTickers).catch(() => new Map<string, string>());
  for (const holding of holdings) {
    holding.icon_url = icons.get(holding.ticker) ?? null;
  }

  return { holdings, warnings: [] };
}
