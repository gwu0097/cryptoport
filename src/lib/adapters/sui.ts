import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// PublicNode's Sui endpoint — verified live (sui-rpc.publicnode.com, not
// the mainnet full-node domain: that host's TLS handshake didn't complete
// from this app's network path, PublicNode's does).
const RPC = "https://sui-rpc.publicnode.com";
const MIST_PER_SUI = 9;

const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

export function isSuiAddress(value: string): boolean {
  return SUI_ADDRESS_RE.test(value);
}

interface GetBalanceResult {
  totalBalance: string; // base units (MIST), decimal string
}

/**
 * A Sui wallet only ever has one holding tracked here (native SUI) — same
 * native-asset-only scope as every other adapter in this app. No
 * "unfunded account" special case needed the way NEAR's view_account
 * throws for one: suix_getBalance just returns "0" for an address with no
 * coin objects, same as an EVM balanceOf call.
 */
export async function fetchSuiHoldings(address: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "cryptoport",
      method: "suix_getBalance",
      params: [address],
    }),
  });
  if (!res.ok) throw new Error(`Sui RPC failed: HTTP ${res.status}`);
  const body: { result?: GetBalanceResult; error?: { message: string } } = await res.json();
  if (body.error) throw new Error(`Sui RPC error: ${body.error.message}`);

  const qty = Number(formatUnits(BigInt(body.result!.totalBalance), MIST_PER_SUI));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["sui"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "SUI",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "sui",
      icon_url: images.get("sui") ?? null,
    },
  ];
}
