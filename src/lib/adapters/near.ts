import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// NEAR Foundation's own public RPC — free, keyless. PublicNode doesn't
// serve NEAR, so this is the standard choice (same one every NEAR wallet's
// default config points at).
const RPC = "https://rpc.mainnet.near.org";
const YOCTO_PER_NEAR = 24;

// A NEAR account id is either a human-readable name (foo.near) or a
// 64-char hex "implicit" account (the raw ed25519 public key, used by
// hardware wallets like the Ledger address in the prompt that started
// this) — both are valid inputs to view_account below. isNearAccountId is
// only used by the top-bar address-lookup feature's chain auto-detection
// (lookup.ts) — deliberately narrower than NEAR's actual account-name
// rules (which permit any bare lowercase name with no suffix at all) to
// avoid false-positive-matching generic search input; a real top-level
// bare account is rare enough on mainnet that requiring the ".near" TLD
// suffix or the unambiguous 64-hex implicit format is the safer trade-off
// for a search box, not a limit on what a *saved* wallet's address can be.
const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;
const NAMED_ACCOUNT_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.near$/;

export function isNearAccountId(value: string): boolean {
  return IMPLICIT_ACCOUNT_RE.test(value) || NAMED_ACCOUNT_RE.test(value);
}

interface ViewAccountResult {
  amount: string; // yoctoNEAR
}
interface RpcResponseBody {
  result?: ViewAccountResult;
  error?: { cause?: { name?: string } };
}

/**
 * A NEAR wallet only ever has one holding tracked here (native NEAR) —
 * same native-asset-only scope as every other adapter in this app. An
 * account that's never been funded is a real, valid state (not an error —
 * view_account returns UNKNOWN_ACCOUNT for it), same "never silently
 * coerce a real zero and a lookup failure into the same thing" rule, just
 * resolved as an empty holdings list rather than throwing.
 */
export async function fetchNearHoldings(accountId: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "cryptoport",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  if (!res.ok) throw new Error(`NEAR RPC failed: HTTP ${res.status}`);
  const body: RpcResponseBody = await res.json();

  if (body.error) {
    if (body.error.cause?.name === "UNKNOWN_ACCOUNT") return [];
    throw new Error(`NEAR RPC error: ${JSON.stringify(body.error)}`);
  }
  if (!body.result) throw new Error(`NEAR RPC returned no result: ${JSON.stringify(body)}`);

  const qty = Number(formatUnits(BigInt(body.result.amount), YOCTO_PER_NEAR));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["near"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "NEAR",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "near",
      icon_url: images.get("near") ?? null,
    },
  ];
}
