// near.com (owner 2026-10-08): its balances live in NEAR Intents' private
// shard ("Confidential Intents" — near.com's "internal network"), which no
// public endpoint shows. They're read from 1Click's account API with a
// User-Session token, got by having the user's wallet sign an EMPTY intent
// (`intents: []` — proves ownership, moves nothing). The token is read-only:
// moving funds always takes a freshly signed intent. Docs:
// docs.near-intents.org — api-reference/user-auth/authenticate-user-with-
// signed-data, api-reference/account/get-user-token-balances. Pure.

import type { AdapterHolding } from "./adapters/types.ts";

/** The provider id (wallets.provider, holdings.chain). Not "near": that's the
 * NEAR chain's own wallet type. */
export const NEARCOM = "nearcom";
/** The refresh token's life (30 days, doesn't rotate): the user signs again. */
export const REFRESH_TOKEN_DAYS = 30;

// A versioned nonce, as intents.near checks it (the official SDK's
// VersionedNonceBuilder, @defuse-protocol/intents-sdk expirable-nonce.ts):
// 4-byte magic, version 0, the contract's current salt (4 bytes,
// `current_salt`), the intent's DEADLINE in nanoseconds (u64, little endian),
// then 15 bytes that start with the time it was made (u64 ns — the server
// rejects one more than 5 minutes off) and end with 7 random bytes. 32 bytes,
// base64.
const NONCE_MAGIC = [0x56, 0x28, 0xf6, 0xc6];

/** `ms` as nanoseconds, u64 little endian, into `out` at `at`. BigInt: they
 * overflow a double's exact range (no `n` literals at this tsconfig target). */
function writeNanos(out: Uint8Array, at: number, ms: number): void {
  const B = BigInt;
  let ns = B(ms) * B(1_000_000);
  for (let i = 0; i < 8; i++) {
    out[at + i] = Number(ns & B(0xff));
    ns >>= B(8);
  }
}

/** The nonce's last 15 bytes: when it was made, then 7 random bytes. */
export function timestampedBytes(nowMs: number, random7: Uint8Array): Uint8Array {
  if (random7.length !== 7) throw new Error("Needs 7 random bytes");
  const out = new Uint8Array(15);
  writeNanos(out, 0, nowMs);
  out.set(random7, 8);
  return out;
}

export function versionedNonce(saltHex: string, deadlineMs: number, inner15: Uint8Array): string {
  if (!/^[0-9a-f]{8}$/i.test(saltHex)) throw new Error(`Unexpected intents salt "${saltHex}"`);
  if (inner15.length !== 15) throw new Error("A nonce needs 15 inner bytes");
  const out = new Uint8Array(32);
  out.set(NONCE_MAGIC, 0);
  out[4] = 0;
  for (let i = 0; i < 4; i++) out[5 + i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
  writeNanos(out, 9, deadlineMs);
  out.set(inner15, 17);
  return btoa(String.fromCharCode(...out));
}

/** The exact string the wallet signs (personal_sign) and the server submits —
 * the key order matters: any difference fails verification. */
export function authPayload(signerId: string, nonce: string, deadline: Date): string {
  return JSON.stringify({ signer_id: signerId.toLowerCase(), verifying_contract: "intents.near", deadline: deadline.toISOString(), nonce, intents: [] });
}

/** The signer and deadline a payload names, or null when it isn't an empty
 * ownership proof for intents.near (the server never forwards anything else). */
export function readAuthPayload(payload: string): { signerId: string; deadline: Date } | null {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    const keys = Object.keys(p).join(",");
    if (keys !== "signer_id,verifying_contract,deadline,nonce,intents") return null;
    if (p.verifying_contract !== "intents.near" || !Array.isArray(p.intents) || p.intents.length !== 0) return null;
    if (typeof p.signer_id !== "string" || !/^0x[0-9a-f]{40}$/.test(p.signer_id)) return null;
    const deadline = new Date(String(p.deadline));
    return Number.isNaN(deadline.getTime()) ? null : { signerId: p.signer_id, deadline };
  } catch {
    return null;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  const B = BigInt;
  let n = B(0);
  for (const b of bytes) n = (n << B(8)) | B(b);
  let s = "";
  while (n > B(0)) {
    s = B58[Number(n % B(58))] + s;
    n /= B(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** A wallet's personal_sign result (0x + r, s, v — 65 bytes) as intents.near
 * takes it: `secp256k1:` + base58, the recovery byte 27/28 mapped to 0/1. */
export function erc191Signature(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{130}$/.test(h)) throw new Error("Not a 65-byte signature");
  const bytes = Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
  if (bytes[64] >= 27) bytes[64] -= 27;
  if (bytes[64] > 1) throw new Error("Unexpected signature recovery byte");
  return `secp256k1:${base58(bytes)}`;
}

/** One entry of 1Click's public token list (GET /v0/tokens). */
export interface IntentsToken {
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  contractAddress?: string | null;
  coingeckoId?: string | null;
}

/** A balance as the account API returns it. */
export interface IntentsBalance {
  tokenId: string;
  available: string;
  source?: string;
}

/** A token's price key: its CoinGecko id when it has a real one, else
 * `nearcom:<assetId>` (near.com's own price). */
export function priceKeyFor(t: Pick<IntentsToken, "assetId" | "coingeckoId">): string {
  const cg = t.coingeckoId?.trim();
  return cg && /^[a-z0-9-]+$/.test(cg) ? cg : `nearcom:${t.assetId}`;
}

/** Balances to holdings, named and priced through the token list: each
 * token's own CoinGecko id is its coin (resolvePriceKey's venue rule), never
 * a ticker guess. Amounts are base units ÷ 10^decimals (a decimal point in
 * the answer means it's already formatted). A token the list doesn't know is
 * kept, unpriced, and named in the warnings — never dropped or valued at 0. */
export function balancesToHoldings(balances: readonly IntentsBalance[], tokens: readonly IntentsToken[]): { holdings: AdapterHolding[]; warnings: string[] } {
  const byId = new Map(tokens.map((t) => [t.assetId, t]));
  const holdings: AdapterHolding[] = [];
  const unknown: string[] = [];
  for (const b of balances) {
    const t = byId.get(b.tokenId);
    const raw = String(b.available ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) continue;
    const qty = raw.includes(".") ? Number(raw) : Number(raw) / 10 ** (t?.decimals ?? 0);
    if (!(qty > 0)) continue;
    if (!t) unknown.push(b.tokenId);
    holdings.push({
      ticker: t?.symbol ?? b.tokenId.replace(/^nep\d+:/, "").slice(0, 24),
      qty,
      usd_override: null,
      contract: b.tokenId,
      category: "token",
      chain: NEARCOM,
      icon_url: null,
      // The coin it's priced as: its CoinGecko id, or — for one near.com
      // names "custom:…" (not a CoinGecko id: QTC, 2026-10-08) — its own key,
      // priced from near.com's token list (the "nearcom" price lane).
      coingecko_id: t ? priceKeyFor(t) : null,
      ...(t ? { display_label: `${t.symbol} (${t.blockchain})` } : {}),
    });
  }
  return { holdings, warnings: unknown.length ? [`${unknown.length} token${unknown.length === 1 ? "" : "s"} not in near.com's token list (unpriced): ${unknown.slice(0, 3).join(", ")}`] : [] };
}
