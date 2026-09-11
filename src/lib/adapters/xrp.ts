import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// Two independent public XRPL nodes, tried in order — xrplcluster.com was
// the more stable of the two during verification (s1.ripple.com returned
// a retryable "tooBusy" once under light load), same "don't depend on one
// free provider" reasoning as BTC/BCH/Substrate/NEO.
const RPCS = ["https://xrplcluster.com", "https://s1.ripple.com:51234"];
const DROPS_PER_XRP = 6;

// Ripple's base58 alphabet is a different permutation from Bitcoin's, but
// a shape check (length + "r" prefix) is enough for lookup.ts's purposes,
// same precedent as this app's other address regexes (real validation
// happens by asking the chain itself).
const XRP_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{25,34}$/;

export function isXrpAddress(value: string): boolean {
  return XRP_ADDRESS_RE.test(value);
}

interface AccountInfoResponse {
  result: {
    account_data?: { Balance: string };
    error?: string; // "actNotFound" for a real, valid, never-funded account
    error_code?: number;
    status: string;
  };
}

async function fetchAccountInfo(rpc: string, address: string): Promise<AccountInfoResponse["result"]> {
  const res = await fetchWithRetry(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "validated" }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: AccountInfoResponse = await res.json();
  return body.result;
}

/**
 * A wallet only ever has one holding tracked here (native XRP, the
 * account's raw Balance field — includes the 10 XRP base reserve locked
 * into the account, real economic value the wallet owns, same "don't
 * silently exclude locked-but-real balance" reasoning as elsewhere in
 * this app) — no trustline/IOU token scanning. "actNotFound" (error_code
 * 19) means a real, valid, never-funded account (below the reserve) —
 * treated as zero, not an error, same "never touched the chain"
 * precedent as NEAR/Filecoin/TON. A different error (e.g. "actMalformed"
 * for a bad address) is a real failure, not a zero, and propagates.
 */
export async function fetchXrpHoldings(address: string): Promise<AdapterHolding[]> {
  const errors: string[] = [];
  let result: AccountInfoResponse["result"] | null = null;
  for (const rpc of RPCS) {
    try {
      result = await fetchAccountInfo(rpc, address);
      break;
    } catch (e) {
      errors.push(`${rpc}: ${(e as Error).message}`);
    }
  }
  if (!result) throw new Error(`All XRPL endpoints failed — ${errors.join("; ")}`);

  if (result.error) {
    if (result.error === "actNotFound") return [];
    throw new Error(`XRPL error: ${result.error}`);
  }

  const qty = Number(formatUnits(BigInt(result.account_data!.Balance), DROPS_PER_XRP));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["ripple"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "XRP",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "xrpl",
      icon_url: images.get("ripple") ?? null,
    },
  ];
}
