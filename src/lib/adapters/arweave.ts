import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// arweave.net gateway — free, keyless (verified live 2026-09-23):
// GET /wallet/{address}/balance returns the balance as a PLAIN-TEXT decimal
// string of winston (not JSON), 200 even for a never-funded address ("0"),
// and 400 {"error":"invalid wallet address"} for a malformed one.
const API_BASE = "https://arweave.net";
const WINSTON_DECIMALS = 12; // 1 AR = 10^12 winston

// An Arweave address is the base64url SHA-256 of the owner's public key:
// exactly 43 characters of [A-Za-z0-9_-]. NOT used for blind chain
// detection (see nonEvmDispatch.ts): every 43-character Solana address is
// also a valid string of this shape (base58 is a subset of base64url), so
// only a wallet's explicit chain label can say which it is. Checked here
// only to fail a sync with a clear message instead of a gateway 400.
const ARWEAVE_ADDRESS_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Native AR only, same native-asset-only scope as the other non-EVM
 * adapters (no AO / ar.io token scanning). Priced through the CoinGecko
 * native-id lane (coingeckoIds.ts NATIVE_ICON_CHAINS: arweave -> "arweave")
 * — AR isn't listed on Coinbase (verified: AR-USD 404), same situation as NEO.
 */
export async function fetchArweaveHoldings(address: string): Promise<AdapterHolding[]> {
  if (!ARWEAVE_ADDRESS_RE.test(address)) {
    throw new Error("Not an Arweave address (expected 43 characters of letters, digits, '-' or '_')");
  }
  const res = await fetchWithRetry(`${API_BASE}/wallet/${address}/balance`);
  if (!res.ok) throw new Error(`arweave.net failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const winston = (await res.text()).trim();
  if (!/^\d+$/.test(winston)) throw new Error(`arweave.net returned a non-numeric balance: ${winston.slice(0, 60)}`);

  const qty = Number(formatUnits(BigInt(winston), WINSTON_DECIMALS));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["arweave"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "AR",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "arweave",
      icon_url: images.get("arweave") ?? null,
    },
  ];
}
