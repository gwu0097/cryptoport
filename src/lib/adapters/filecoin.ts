import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// Filfox — free, keyless indexer API. Verified live against a real address
// (balance in attoFIL matches Glif's Filecoin.WalletBalance RPC exactly,
// see the adapter's own doc comment below for why Filfox is primary
// anyway).
const API_BASE = "https://filfox.info/api/v1";
const ATTOFIL_PER_FIL = 18;

// f0 (ID actor, decimal), f1 (secp256k1, 39 base32 chars), f2 (actor, 39
// base32 chars), f3 (BLS, 86 base32 chars) — real per-protocol lengths, not
// a loose shape check: a generic "f + digit 0-4 + alnum" pattern would
// also match a 64-char NEAR implicit account that happens to start with
// f0-f4 (both are bare lowercase alnum with no other distinguishing
// marker), so this only accepts the exact lengths real Filecoin addresses
// come in. f4/t4 (delegated/FEVM) addresses aren't matched here — none of
// this app's real usage needs them yet, and Filfox is the real validator
// regardless (a malformed address 404s the same as a valid-but-never-used
// one, see below).
const FIL_ADDRESS_RE = /^f(?:0\d{1,20}|1[a-z2-7]{39}|2[a-z2-7]{39}|3[a-z2-7]{86})$/;

export function isFilecoinAddress(value: string): boolean {
  return FIL_ADDRESS_RE.test(value);
}

interface AddressInfo {
  balance: string; // attoFIL
}

/**
 * A Filecoin wallet only ever has one holding tracked here (native FIL) —
 * same native-asset-only scope as every other adapter in this app (no
 * storage-deal/miner-collateral accounting). Filfox over Glif's direct
 * Filecoin.WalletBalance RPC as primary — both return the identical
 * balance for a real address (verified) — because Filfox's 404 cleanly
 * means "no on-chain history", the same semantics as Koios's address_info
 * for Cardano, whereas Glif's RPC error strings don't reliably distinguish
 * a malformed address from a valid-but-never-funded one. A 404 here is
 * treated as zero, not an error, same reasoning as everywhere else in this
 * app that a real "never touched the chain" state isn't a failure.
 */
export async function fetchFilecoinHoldings(address: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(`${API_BASE}/address/${address}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Filfox address lookup failed: HTTP ${res.status}`);
  const body: AddressInfo = await res.json();

  const qty = Number(formatUnits(BigInt(body.balance), ATTOFIL_PER_FIL));
  if (qty <= 0) return [];

  const images = await fetchTokenImages(["filecoin"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "FIL",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "filecoin",
      icon_url: images.get("filecoin") ?? null,
    },
  ];
}
