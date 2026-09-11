import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// Aptos Labs' own public fullnode — free, keyless (verified live).
const API_BASE = "https://fullnode.mainnet.aptoslabs.com/v1";
const OCTAS_PER_APT = 8;

/**
 * A never-used or never-funded account isn't distinguished from any other
 * — this endpoint isn't tied to whether an account resource exists (which
 * the older CoinStore-based lookup was: many accounts have migrated APT
 * to the newer Fungible Asset standard and no longer have a CoinStore
 * resource at all, verified live against several real rich-list
 * addresses that all 404'd on the CoinStore path). The
 * .../balance/0x1::aptos_coin::AptosCoin endpoint works for both migrated
 * and unmigrated accounts uniformly, returning a bare integer (octas) —
 * "0" as plain text for an account with nothing, not a 404 or an error
 * envelope, verified live.
 */
export async function fetchAptosHoldings(address: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(`${API_BASE}/accounts/${address}/balance/0x1::aptos_coin::AptosCoin`);
  if (!res.ok) throw new Error(`Aptos fullnode failed: HTTP ${res.status}`);
  const raw = (await res.text()).trim();

  const qty = Number(formatUnits(BigInt(raw), OCTAS_PER_APT));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["aptos"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "APT",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "aptos",
      icon_url: images.get("aptos") ?? null,
    },
  ];
}
