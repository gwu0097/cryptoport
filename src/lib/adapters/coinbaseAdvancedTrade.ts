import "server-only";
import { createSign, randomBytes } from "node:crypto";
import type { AdapterHolding } from "./types";

const API_HOST = "api.coinbase.com";
const ACCOUNTS_PATH = "/api/v3/brokerage/accounts";

/**
 * Coinbase's Advanced Trade API (a user-generated "View"-permission key, not
 * OAuth2 — see the "Connect Coinbase" plan for why: OAuth2 client
 * registration turned out to require Coinbase partner approval with no
 * self-serve path, a real blocker found live, not assumed). Every request
 * needs its own ES256 JWT (2-minute expiry, bound to one method+path via
 * the `uri` claim — never cached/reused across calls). No JWT library
 * needed: verified live this session that Node's own `crypto.sign` produces
 * a JOSE-valid signature as long as `dsaEncoding: "ieee-p1363"` is passed —
 * the default DER encoding silently produces an invalid JWT that Coinbase
 * rejects, the exact trap a naive implementation hits.
 *
 * The private key a user gets from portal.cdp.coinbase.com is PEM-encoded
 * EC (P-256) — the portal's *recommended* default is actually Ed25519,
 * which silently 401s against this API; the UI copy has to explicitly
 * steer users to select ECDSA instead (see ConnectCoinbaseModal.tsx).
 */
function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Coinbase's downloaded API-key JSON file stores the private key as a JSON
 * string, with its real line breaks escaped as literal two-character `\n`
 * sequences — copying that value straight out and pasting it into a plain
 * textarea leaves those as literal backslash-n characters, not real
 * newlines, which OpenSSL's PEM decoder can't parse ("error:1E08010C:
 * DECODER routines::unsupported" — a real error hit live, not hypothetical).
 * Idempotent against a key that already has real newlines (nothing to
 * replace), so this is safe regardless of how the key was copied. */
function normalizePemKey(key: string): string {
  return key.trim().replace(/\\n/g, "\n");
}

export function mintCoinbaseJwt(keyName: string, rawPemPrivateKey: string, method: string, path: string): string {
  const pemPrivateKey = normalizePemKey(rawPemPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: keyName, nonce: randomBytes(16).toString("hex") };
  const payload = {
    iss: "cdp",
    sub: keyName,
    nbf: now,
    exp: now + 120,
    uri: `${method} ${API_HOST}${path}`,
  };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("sha256");
  signer.update(signingInput);
  signer.end();
  // ieee-p1363 = raw r‖s (64 bytes for P-256), what JOSE/JWT requires —
  // createSign's default is DER-encoded, which Coinbase rejects outright.
  const signature = signer.sign({ key: pemPrivateKey, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
}

interface CoinbaseAccount {
  uuid: string;
  currency: string;
  available_balance?: { value: string; currency: string };
  type?: string;
  platform?: string;
}

interface AccountsResponse {
  accounts: CoinbaseAccount[];
  has_next: boolean;
  cursor?: string;
}

async function fetchAccountsPage(
  keyName: string,
  pemPrivateKey: string,
  cursor?: string,
): Promise<AccountsResponse> {
  const path = cursor ? `${ACCOUNTS_PATH}?cursor=${encodeURIComponent(cursor)}` : ACCOUNTS_PATH;
  const jwt = mintCoinbaseJwt(keyName, pemPrivateKey, "GET", ACCOUNTS_PATH);
  const res = await fetch(`https://${API_HOST}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The two real failure modes a user will actually hit: a 401 almost
    // always means either an Ed25519 key (see doc comment above) or a
    // stale/deleted key; a 403 means the key's permission isn't "View" (or
    // higher) — surfaced distinctly so the error the user sees points at
    // the actual fix, not a generic "request failed".
    if (res.status === 401) {
      throw new Error(
        "Coinbase rejected this key (401) — double check it was created with signature algorithm ECDSA, not Ed25519, and that it hasn't been deleted from the Coinbase portal.",
      );
    }
    if (res.status === 403) {
      throw new Error("Coinbase rejected this key (403) — it needs at least \"View\" permission.");
    }
    throw new Error(`Coinbase accounts request failed: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * Every account this key's "View" permission can see. Spot/fiat balances
 * only this pass — a CFM perpetual-futures position (account.type ===
 * "ACCOUNT_TYPE_PERP_FUTURES", live-confirmed reachable through this same
 * endpoint/key even though OAuth2 could never see it at all) is skipped and
 * surfaced as a warning instead of silently dropped: a leveraged position
 * needs its own notional/margin/PnL valuation design, not a quick bolt-on
 * that would misrepresent it as a plain balance.
 */
export async function fetchCoinbaseBalances(
  keyName: string,
  pemPrivateKey: string,
): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const holdings: AdapterHolding[] = [];
  let perpCount = 0;
  let cursor: string | undefined;

  do {
    const page = await fetchAccountsPage(keyName, pemPrivateKey, cursor);
    for (const account of page.accounts) {
      if (account.type === "ACCOUNT_TYPE_PERP_FUTURES") {
        perpCount++;
        continue;
      }
      const qty = Number(account.available_balance?.value ?? "0");
      if (!Number.isFinite(qty) || qty === 0) continue;

      holdings.push({
        ticker: account.currency,
        qty,
        usd_override: null, // priced via the existing ticker-keyed path — Coinbase is already a pricing source in prices.ts
        contract: null,
        category: "token",
        chain: "coinbase",
        icon_url: null,
      });
    }
    cursor = page.has_next ? page.cursor : undefined;
  } while (cursor);

  const warnings: string[] = [];
  if (perpCount > 0) {
    warnings.push(`coinbase: ${perpCount} perp futures position(s) found, not yet tracked`);
  }
  return { holdings, warnings };
}
