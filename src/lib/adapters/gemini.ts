import "server-only";
import { createHmac } from "node:crypto";
import { fetchWithRetry } from "./http";
import { resolveTickerIcons } from "./coingecko";
import type { AdapterHolding } from "./types";

const API_HOST = "https://api.gemini.com";
const BALANCES_PATH = "/v1/balances";

// Same fiat-icon trap already found live for Coinbase/Kraken — never sent
// to resolveTickerIcons.
const FIAT_TICKERS = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SGD"]);

interface GeminiBalance {
  type: string;
  currency: string;
  amount: string;
  available: string;
}

/**
 * A user-generated API key with the "Auditor" role (read-only — live-
 * verified this is Gemini's own dedicated view-only role, can't be
 * combined with Trader/Fund Manager, and is explicitly sufficient for the
 * balances endpoint). Gemini also has an OAuth2 flow with a genuinely
 * self-serve *sandbox*, but production access still needs Gemini's review
 * before it works for a real account — the API-key route works today, same
 * choice already made for Coinbase/Kraken.
 *
 * Signing (developer.gemini.com/authentication/api-key, live-verified):
 * a JSON payload ({request, nonce}) is base64-encoded and sent directly as
 * the X-GEMINI-PAYLOAD header — the actual HTTP body stays empty — signed
 * as hex(HMAC-SHA384(base64Payload, key=apiSecret)) using the *raw* secret
 * string as the HMAC key, unlike Kraken/Coinbase's own base64/PEM-decoded
 * key material.
 */
export async function fetchGeminiBalances(
  apiKey: string,
  apiSecret: string,
): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const payload = { request: BALANCES_PATH, nonce: Date.now().toString() };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const signature = createHmac("sha384", apiSecret).update(payloadBase64).digest("hex");

  const res = await fetchWithRetry(`${API_HOST}${BALANCES_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-GEMINI-APIKEY": apiKey,
      "X-GEMINI-PAYLOAD": payloadBase64,
      "X-GEMINI-SIGNATURE": signature,
      "Cache-Control": "no-cache",
    },
    body: "", // empty body — the whole payload rides in the header above
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Gemini rejected this key — double check it has at least the Auditor role and hasn't been deleted from your account settings.",
      );
    }
    throw new Error(`Gemini balances request failed: HTTP ${res.status} ${body}`);
  }

  const balances: GeminiBalance[] = await res.json();
  const holdings: AdapterHolding[] = [];
  for (const b of balances) {
    const qty = Number(b.amount);
    if (!Number.isFinite(qty) || qty === 0) continue;
    holdings.push({
      ticker: b.currency.toUpperCase(),
      qty,
      usd_override: null, // priced via the existing ticker-keyed path, same as Coinbase/Kraken's spot balances
      contract: null,
      category: "token",
      chain: "gemini",
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
