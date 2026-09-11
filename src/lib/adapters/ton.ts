import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// toncenter.com — free, keyless (verified live). Anonymous tier is capped
// at 1 req/s (a free API key via their Telegram bot raises that, not
// needed for this app's scale) — fetchWithRetry's backoff already covers
// an occasional 429 from bumping that limit.
const API_BASE = "https://toncenter.com/api/v2";
const NANOTON_PER_TON = 9;

// TON's "user-friendly" address form: 48 base64url characters, always
// starting with one of a handful of known prefixes (EQ/UQ for
// bounceable/non-bounceable mainnet, kQ/0Q for testnet) — narrow enough
// not to collide with this app's other supported address formats (SS58
// addresses are a similar length but never contain base64url's `_`/`-` or
// use these specific prefixes).
const TON_ADDRESS_RE = /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/;

export function isTonAddress(value: string): boolean {
  return TON_ADDRESS_RE.test(value);
}

interface BalanceResponse {
  ok: boolean;
  result?: string; // nanotons, as a decimal string
  error?: string;
}

/**
 * A TON wallet only ever has one holding tracked here (native TON) — same
 * native-asset-only scope as every other adapter in this app (no
 * Jetton/token scanning). A never-funded address isn't a distinct error
 * state the way NEAR's UNKNOWN_ACCOUNT is — toncenter just returns "0"
 * for it, same as an EVM balanceOf call.
 */
export async function fetchTonHoldings(address: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(`${API_BASE}/getAddressBalance?address=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`toncenter failed: HTTP ${res.status}`);
  const body: BalanceResponse = await res.json();
  if (!body.ok) throw new Error(`toncenter error: ${body.error ?? "unknown"}`);

  const qty = Number(formatUnits(BigInt(body.result ?? "0"), NANOTON_PER_TON));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["the-open-network"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "TON",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "ton",
      icon_url: images.get("the-open-network") ?? null,
    },
  ];
}
