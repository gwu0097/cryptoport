import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// DFINITY's own Rosetta API — free, keyless (verified live). The
// alternative (ic-api.internetcomputer.org) is principal/neuron-oriented,
// not account-identifier-oriented, so it can't do a plain balance lookup
// the way this app's other adapters do.
const API_BASE = "https://rosetta-api.internetcomputer.org";
// Rosetta's fixed network identifier for the IC mainnet — not a secret or
// a variable, just how every Rosetta call addresses this chain.
const NETWORK_IDENTIFIER = { blockchain: "Internet Computer", network: "00000000000000020101" };
const E8S_PER_ICP = 8;

interface BalanceResponse {
  balances?: { value: string; currency: { symbol: string; decimals: number } }[];
  code?: number;
  message?: string;
}

/**
 * A wallet only ever has one holding tracked here (native ICP) — same
 * native-asset-only scope as every other adapter in this app. Takes an
 * ICP "account identifier" (64-char hex — what every ICP wallet actually
 * displays and what the address in the prompt that started this uses),
 * not a principal; Rosetta's account_identifier field is exactly that
 * format. An invalid/malformed account identifier returns HTTP 500 with
 * a Rosetta error envelope (code 711, "Account not found") — that's a
 * real failure (bad input), not treated as zero.
 */
export async function fetchIcpHoldings(accountIdentifier: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(`${API_BASE}/account/balance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      network_identifier: NETWORK_IDENTIFIER,
      account_identifier: { address: accountIdentifier },
    }),
  });
  const body: BalanceResponse = await res.json();
  if (!res.ok || body.code) {
    throw new Error(`ICP Rosetta error: ${body.message ?? `HTTP ${res.status}`}`);
  }

  const balance = body.balances?.[0];
  if (!balance) return [];
  const qty = Number(formatUnits(BigInt(balance.value), E8S_PER_ICP));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["internet-computer"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "ICP",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "internet-computer",
      icon_url: images.get("internet-computer") ?? null,
    },
  ];
}
