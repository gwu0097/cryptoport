import "server-only";
import { createHmac, createHash } from "node:crypto";
import { fetchWithRetry } from "./http";
import { resolveTickerIcons } from "./coingecko";
import type { AdapterHolding } from "./types";

// CoinGecko has no crypto icon for a fiat code, and its "best symbol
// match" for one is some unrelated obscure coin that happens to share the
// letters (same trap already found live for Coinbase's own fiat balances)
// — never sent to resolveTickerIcons.
const FIAT_TICKERS = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"]);

const API_HOST = "https://api.kraken.com";
const BALANCE_PATH = "/0/private/Balance";
const ASSETS_PATH = "/0/public/Assets";

// Kraken's own idiosyncratic asset codes vs. this app's ticker convention
// (CoinGecko/Coinbase-style elsewhere) — live-verified via Kraken's own
// /0/public/Assets: XXBT's altname is "XBT", not "BTC", the one real
// mismatch found; every other legacy X/Z-prefixed code's altname already
// matches what this app expects (XETH -> ETH, ZUSD -> USD, ...).
const TICKER_OVERRIDES: Record<string, string> = { XBT: "BTC" };

interface KrakenResponse<T> {
  error: string[];
  result: T;
}

/**
 * Kraken's own documented algorithm (support.kraken.com's own signing
 * article, live-verified against the current docs, not recalled from
 * training data): HMAC-SHA512 of (URI path + SHA256(nonce + POST data)),
 * keyed by the base64-decoded API secret, base64-encoded as the API-Sign
 * header. The nonce appears twice by design — once raw, prefixed onto the
 * SHA256 input, and again inside the form-encoded POST body itself.
 */
function sign(path: string, nonce: string, postData: string, secretBase64: string): string {
  const sha256 = createHash("sha256").update(nonce + postData).digest();
  const hmacInput = Buffer.concat([Buffer.from(path), sha256]);
  return createHmac("sha512", Buffer.from(secretBase64, "base64")).update(hmacInput).digest("base64");
}

async function privatePost<T>(path: string, apiKey: string, apiSecret: string): Promise<T> {
  const nonce = Date.now().toString();
  const postData = `nonce=${nonce}`;
  const signature = sign(path, nonce, postData, apiSecret);

  const res = await fetchWithRetry(`${API_HOST}${path}`, {
    method: "POST",
    headers: {
      "API-Key": apiKey,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postData,
  });
  if (!res.ok) throw new Error(`Kraken request failed: HTTP ${res.status}`);
  const body: KrakenResponse<T> = await res.json();
  if (body.error.length > 0) {
    // Kraken's own error strings are already user-facing (e.g.
    // "EAPI:Invalid key", "EGeneral:Permission denied", "EAPI:Invalid
    // signature") — surfaced directly rather than re-wrapped.
    throw new Error(`Kraken: ${body.error.join("; ")}`);
  }
  return body.result;
}

// Fetched once per server instance, not per call — the asset list is
// large (thousands of rows) and changes rarely; same "cache slow-changing
// external data" reasoning as this app's own token_registry, just
// in-memory rather than a DB table since this is public, non-sensitive,
// and cheap to refetch if the instance recycles.
let assetAltnameCache: Map<string, string> | null = null;
async function getAssetAltnames(): Promise<Map<string, string>> {
  if (assetAltnameCache) return assetAltnameCache;
  const res = await fetchWithRetry(`${API_HOST}${ASSETS_PATH}`);
  if (!res.ok) throw new Error(`Kraken asset list failed: HTTP ${res.status}`);
  const body: KrakenResponse<Record<string, { altname: string }>> = await res.json();
  const map = new Map<string, string>();
  for (const [code, info] of Object.entries(body.result)) map.set(code, info.altname);
  assetAltnameCache = map;
  return map;
}

function normalizeTicker(code: string, altnames: Map<string, string>): string {
  // Staking/bonded balance variants use a dot suffix (e.g. "DOT.S") not
  // present as its own entry in the asset list — strip it and resolve the
  // base asset instead. Falls back to the raw code untouched if nothing
  // matches (still shows up as a holding, just under Kraken's own code
  // until this app's ticker table catches up — never dropped).
  const base = code.split(".")[0];
  const altname = altnames.get(base) ?? altnames.get(code) ?? base;
  return TICKER_OVERRIDES[altname] ?? altname;
}

/**
 * A user-generated API key with "Query Funds" permission only — Kraken
 * also has "Kraken Connect" (OAuth2 for third-party apps), but its
 * registration reads as manual/Kraken-provisioned rather than a self-serve
 * developer dashboard (unconfirmed either way live), so this uses the
 * definitely-self-serve API-key route instead, same choice already made
 * for Coinbase.
 */
export async function fetchKrakenBalances(
  apiKey: string,
  apiSecret: string,
): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const [balances, altnames] = await Promise.all([
    privatePost<Record<string, string>>(BALANCE_PATH, apiKey, apiSecret),
    getAssetAltnames().catch(() => new Map<string, string>()),
  ]);

  const holdings: AdapterHolding[] = [];
  for (const [code, value] of Object.entries(balances)) {
    const qty = Number(value);
    if (!Number.isFinite(qty) || qty === 0) continue;
    holdings.push({
      ticker: normalizeTicker(code, altnames),
      qty,
      usd_override: null, // priced via the existing ticker-keyed path, same as Coinbase's spot balances
      contract: null,
      category: "token",
      chain: "kraken",
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
