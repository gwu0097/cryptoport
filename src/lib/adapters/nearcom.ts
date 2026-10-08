import "server-only";
import { fetchWithRetry } from "./http";
import { resolveTickerIcons } from "./coingecko";
import { balancesToHoldings, timestampedBytes, versionedNonce, authPayload, erc191Signature, type IntentsBalance, type IntentsToken } from "../nearIntents";
import type { AdapterHolding } from "./types";

// near.com balances (Confidential Intents) through NEAR Intents' 1Click API —
// pure parts and the why in nearIntents.ts. Free, keyless for user sessions;
// limits unpublished. Per sync: one refresh + one balances call (the token
// list is kept an hour). Checked live 2026-10-08 with a throwaway key:
// authenticate 201 (a 15-minute access token, a 30-day refresh token),
// refresh 201, balances 200.

const API = "https://1click.chaindefuser.com/v0";
// Its CDN refuses a request with no User-Agent (403, seen 2026-10-08).
const HEADERS = { "Content-Type": "application/json", "User-Agent": "cryptoport" };

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: T }> {
  const res = await fetchWithRetry(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { ...HEADERS, ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

/** intents.near's current nonce salt (NEAR's public RPC, a free view call). */
async function currentSalt(): Promise<string> {
  const res = await fetchWithRetry("https://rpc.mainnet.near.org", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: "cryptoport", method: "query", params: { request_type: "call_function", finality: "final", account_id: "intents.near", method_name: "current_salt", args_base64: btoa("{}") } }),
    cache: "no-store",
  });
  const json = (await res.json()) as { result?: { result?: number[] } };
  const bytes = json.result?.result;
  if (!bytes) throw new Error("Couldn't read intents.near's salt");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as string;
}

/** The message a wallet signs to connect: an empty intent, valid 5 minutes. */
export async function nearComChallenge(address: string): Promise<string> {
  const now = Date.now();
  const deadline = new Date(now + 5 * 60_000);
  const random7 = crypto.getRandomValues(new Uint8Array(7));
  return authPayload(address, versionedNonce(await currentSalt(), deadline.getTime(), timestampedBytes(now, random7)), deadline);
}

/** The signed message for a refresh token (read-only, 30 days). */
export async function nearComAuthenticate(payload: string, signatureHex: string): Promise<string> {
  const { status, body } = await call<{ refreshToken?: string; message?: string }>("/auth/authenticate", {
    method: "POST",
    body: { signedData: { standard: "erc191", payload, signature: erc191Signature(signatureHex) } },
  });
  if (!body.refreshToken) throw new Error(`near.com didn't accept the signature (HTTP ${status}${body.message ? `: ${body.message}` : ""}).`);
  return body.refreshToken;
}

let tokens: { at: number; list: Promise<IntentsToken[]> } | null = null;
/** The public token list (204 tokens, each with its chain, contract and
 * CoinGecko id), kept an hour per instance. */
function tokenList(): Promise<IntentsToken[]> {
  if (!tokens || Date.now() - tokens.at > 3_600_000) {
    const list = call<IntentsToken[]>("/tokens").then(({ status, body }) => {
      if (!Array.isArray(body)) throw new Error(`near.com token list: HTTP ${status}`);
      return body;
    });
    tokens = { at: Date.now(), list };
    list.catch(() => (tokens = null));
  }
  return tokens.list;
}

export const NEARCOM_EXPIRED = "near.com connection expired — click Reconnect and sign again (it lasts 30 days).";

/** The exchange fetcher (EXCHANGE_ADAPTERS): `keyName` is the account
 * (lowercase 0x address), `secret` the refresh token. Throws rather than
 * returning [] on any failure — the exchange save replaces every row. */
export async function fetchNearComHoldings(_account: string, refreshToken: string): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const refreshed = await call<{ accessToken?: string }>("/auth/refresh", { method: "POST", body: { refreshToken } });
  if (refreshed.status === 401 || refreshed.status === 403) throw new Error(NEARCOM_EXPIRED);
  if (!refreshed.body.accessToken) throw new Error(`near.com sign-in refresh failed (HTTP ${refreshed.status})`);
  const [{ status, body }, list] = await Promise.all([call<{ balances?: IntentsBalance[] }>("/account/balances", { token: refreshed.body.accessToken }), tokenList()]);
  if (!Array.isArray(body.balances)) throw new Error(`near.com balances: HTTP ${status}`);
  const { holdings, warnings } = balancesToHoldings(body.balances, list);
  const icons = await resolveTickerIcons(holdings.map((h) => h.ticker)).catch(() => new Map<string, string | null>());
  return { holdings: holdings.map((h) => ({ ...h, icon_url: icons.get(h.ticker) ?? null })), warnings };
}
