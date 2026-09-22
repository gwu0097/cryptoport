import "server-only";
import { createHmac } from "node:crypto";
import { fetchWithRetry } from "./http";
import { resolveTickerIcons } from "./coingecko";
import type { AdapterHolding } from "./types";

const API_HOST = "https://api.gemini.com";
const BALANCES_PATH = "/v1/balances";
const ACCOUNT_LIST_PATH = "/v1/account/list";

// Same fiat-icon trap already found live for Coinbase/Kraken — never sent
// to resolveTickerIcons.
const FIAT_TICKERS = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SGD"]);

interface GeminiBalance {
  type: string;
  currency: string;
  amount: string;
  available: string;
}

interface GeminiAccountListEntry {
  account: string;
}

type GeminiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason: string | null; body: string };

/**
 * One signed POST — shared by the balances call and (for a Master key
 * only) the account-list call below, since both use the exact same
 * {request, nonce} + HMAC-SHA384 envelope. `extra` merges into the signed
 * payload (e.g. `{account: "primary"}`).
 *
 * Signing (developer.gemini.com/authentication/api-key, live-verified):
 * a JSON payload is base64-encoded and sent directly as the
 * X-GEMINI-PAYLOAD header — the actual HTTP body stays empty — signed as
 * hex(HMAC-SHA384(base64Payload, key=apiSecret)) using the *raw* secret
 * string as the HMAC key, unlike Kraken/Coinbase's own base64/PEM-decoded
 * key material.
 */
async function geminiPost<T>(
  apiKey: string,
  apiSecret: string,
  path: string,
  extra: Record<string, unknown> = {},
): Promise<GeminiResult<T>> {
  // Gemini validates the nonce against its own server clock in Unix
  // *seconds* (live-verified from a real 400: "Nonce '1790040997692' is
  // not within 30 seconds of server time '1790040997'" — the rejected
  // nonce was literally the server's own second value in milliseconds,
  // Date.now() sent unconverted), not the millisecond epoch every other
  // adapter's nonce/timestamp in this app uses.
  const payload = { request: path, nonce: Math.floor(Date.now() / 1000).toString(), ...extra };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const signature = createHmac("sha384", apiSecret).update(payloadBase64).digest("hex");

  const res = await fetchWithRetry(`${API_HOST}${path}`, {
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
    let reason: string | null = null;
    try {
      reason = (JSON.parse(body) as { reason?: string }).reason ?? null;
    } catch {
      // non-JSON error body — reason stays null, caller falls through to the generic message
    }
    return { ok: false, status: res.status, reason, body };
  }
  return { ok: true, data: (await res.json()) as T };
}

function throwGeminiError(result: { status: number; body: string }): never {
  if (result.status === 401 || result.status === 403) {
    throw new Error(
      "Gemini rejected this key — double check it has at least the Auditor role and hasn't been deleted from your account settings.",
    );
  }
  throw new Error(`Gemini balances request failed: HTTP ${result.status} ${result.body}`);
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
 * Gemini has two key types (see the "Starts with account- or master-"
 * hint already shown in the connect form): a plain "account-" key belongs
 * to exactly one account and /v1/balances works with no extra payload. A
 * "master-" key spans every sub-account under it and, live-verified from a
 * real 400 (`{"reason":"MissingAccounts","message":"Expected a JSON
 * payload with accounts"}`), REQUIRES a per-request `account` field naming
 * which one — there's no "give me everything" shortcut. Rather than ask
 * the user which key type theirs is, this always tries the plain call
 * first (the common case, zero extra requests) and only on that specific
 * `MissingAccounts` reason falls back to listing every sub-account
 * (`/v1/account/list`) and pulling + summing balances from each — never
 * hardcodes "primary", since a master key can have several differently-
 * named sub-accounts and picking just one would silently under-report
 * real holdings (the exact "missing data, not zero" trap CLAUDE.md's Data
 * Correctness section warns about). Per-account calls run sequentially,
 * not Promise.all'd — concurrent calls in the same wall-clock second would
 * mint the same seconds-resolution nonce twice, which Gemini's replay
 * protection would reject as reused.
 */
export async function fetchGeminiBalances(
  apiKey: string,
  apiSecret: string,
): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const first = await geminiPost<GeminiBalance[]>(apiKey, apiSecret, BALANCES_PATH);
  let balances: GeminiBalance[];
  if (first.ok) {
    balances = first.data;
  } else if (first.reason === "MissingAccounts") {
    const accountList = await geminiPost<GeminiAccountListEntry[]>(apiKey, apiSecret, ACCOUNT_LIST_PATH);
    if (!accountList.ok) throwGeminiError(accountList);
    if (accountList.data.length === 0) {
      throw new Error("Gemini reported no accounts under this master key.");
    }
    balances = [];
    for (const { account } of accountList.data) {
      const perAccount = await geminiPost<GeminiBalance[]>(apiKey, apiSecret, BALANCES_PATH, { account });
      if (!perAccount.ok) throwGeminiError(perAccount);
      balances.push(...perAccount.data);
    }
  } else {
    throwGeminiError(first);
  }

  // A master key's sub-accounts can (and often do) hold the same ticker —
  // summed into one row per ticker rather than returned as separate rows,
  // since they're all still just balances of this one connected wallet.
  const qtyByTicker = new Map<string, number>();
  for (const b of balances) {
    const qty = Number(b.amount);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const ticker = b.currency.toUpperCase();
    qtyByTicker.set(ticker, (qtyByTicker.get(ticker) ?? 0) + qty);
  }

  const holdings: AdapterHolding[] = [...qtyByTicker.entries()].map(([ticker, qty]) => ({
    ticker,
    qty,
    usd_override: null, // priced via the existing ticker-keyed path, same as Coinbase/Kraken's spot balances
    contract: null,
    category: "token",
    chain: "gemini",
    icon_url: null, // filled in below via resolveTickerIcons
  }));

  const iconTickers = holdings.map((h) => h.ticker).filter((t) => !FIAT_TICKERS.has(t));
  const icons = await resolveTickerIcons(iconTickers).catch(() => new Map<string, string>());
  for (const holding of holdings) {
    holding.icon_url = icons.get(holding.ticker) ?? null;
  }

  return { holdings, warnings: [] };
}
