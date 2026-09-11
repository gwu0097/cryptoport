import "server-only";
import { xxhashAsU8a, blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";
import { u8aConcat, u8aToHex } from "@polkadot/util";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

/**
 * Both Polkadot and Bittensor are Substrate chains with no free indexer
 * API left that doesn't require a key (Subscan and Polkaholic both
 * dropped keyless access; Taostats requires signup). The only reliable
 * free path is the same one every Substrate wallet actually uses under
 * the hood: a raw `state_getStorage` RPC call for the chain's
 * `System::Account` storage entry, decoded by hand — no `@polkadot/api`
 * client needed (that pulls in a much heavier metadata/type-registry
 * layer this app doesn't need for a single well-known storage item).
 *
 * The storage key itself is `twox128("System") ++ twox128("Account") ++
 * blake2_128Concat(pubkey)` (Substrate's standard StorageMap key
 * encoding) — verified byte-for-byte two ways before trusting this:
 * (1) computed the key for the Polkadot Treasury's well-known
 * "modlpy/trsry"-derived account and confirmed the raw bytes literally
 * spell that out, a documented fact about how that specific account is
 * derived; (2) queried a real address's storage key against three
 * independent RPC providers (PublicNode, Parity's own rpc.polkadot.io,
 * OnFinality) and got identical results from all three.
 *
 * `AccountData`'s layout after the first 16 bytes (nonce/consumers/
 * providers/sufficients, all u32) varies by runtime version — Polkadot's
 * has a trailing `flags` field Bittensor's doesn't, for example — but
 * `free` (the field this app actually reads) is always the very next
 * u128 right after that 16-byte header on every Substrate chain, so this
 * only ever reads bytes 16-32 and ignores everything after, sidestepping
 * that variation entirely rather than trying to model each chain's full
 * tail layout.
 */
export interface SubstrateChainConfig {
  id: string;
  name: string;
  /** SS58 address-format prefix (0 for Polkadot; Bittensor reuses the
   * generic Substrate prefix 42, same as dozens of other chains — not
   * unique enough to auto-detect from a bare address, see
   * isSubstrateAddress). */
  ss58Prefix: number;
  decimals: number;
  nativeCoingeckoId: string;
  nativeSymbol: string;
  chainSlug: string;
  /** Tried in order — independent operators, same "don't depend on one
   * free provider's uptime" reasoning as BTC's/BCH's multi-provider
   * setups. */
  rpcs: string[];
}

export const SUBSTRATE_CHAINS: SubstrateChainConfig[] = [
  {
    id: "DOT",
    name: "Polkadot",
    ss58Prefix: 0,
    decimals: 10,
    nativeCoingeckoId: "polkadot",
    nativeSymbol: "DOT",
    chainSlug: "polkadot",
    rpcs: [
      "https://polkadot-rpc.publicnode.com",
      "https://rpc.polkadot.io",
      "https://polkadot.api.onfinality.io/public",
    ],
  },
  {
    id: "TAO",
    name: "Bittensor",
    ss58Prefix: 42,
    decimals: 9,
    nativeCoingeckoId: "bittensor",
    nativeSymbol: "TAO",
    chainSlug: "bittensor",
    rpcs: ["https://entrypoint-finney.opentensor.ai", "https://lite.chain.opentensor.ai"],
  },
];

export function substrateChainFor(chainId: string): SubstrateChainConfig | undefined {
  return SUBSTRATE_CHAINS.find((c) => c.id === chainId);
}

export function isSubstrateAddress(chainId: string, address: string): boolean {
  const cfg = substrateChainFor(chainId);
  if (!cfg) return false;
  try {
    decodeAddress(address, false, cfg.ss58Prefix);
    return true;
  } catch {
    return false;
  }
}

function accountStorageKey(pubkey: Uint8Array): string {
  return u8aToHex(u8aConcat(xxhashAsU8a("System", 128), xxhashAsU8a("Account", 128), blake2AsU8a(pubkey, 128), pubkey));
}

function readU128LE(buf: Buffer, offset: number): bigint {
  let val = BigInt(0);
  for (let i = 15; i >= 0; i--) val = (val << BigInt(8)) | BigInt(buf[offset + i]);
  return val;
}

interface StorageResponse {
  result?: string | null;
  error?: { message: string };
}

async function stateGetStorage(rpc: string, hexKey: string): Promise<string | null> {
  const res = await fetchWithRetry(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "state_getStorage", params: [hexKey] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: StorageResponse = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result ?? null;
}

async function fetchWithFailover(cfg: SubstrateChainConfig, hexKey: string): Promise<string | null> {
  const errors: string[] = [];
  for (const rpc of cfg.rpcs) {
    try {
      return await stateGetStorage(rpc, hexKey);
    } catch (e) {
      errors.push(`${rpc}: ${(e as Error).message}`);
    }
  }
  throw new Error(`All ${cfg.name} RPC endpoints failed — ${errors.join("; ")}`);
}

/**
 * A Substrate wallet only ever has one holding tracked here (the chain's
 * native token, `free` balance) — same native-asset-only, spendable-
 * balance scope as every other adapter in this app. A null
 * `state_getStorage` result means the account has no `System::Account`
 * entry at all (below the existential deposit, or simply never funded) —
 * a real, valid zero, not an error, same "never touched the chain"
 * precedent as NEAR/Filecoin above.
 */
export async function fetchSubstrateHoldings(chainId: string, address: string): Promise<AdapterHolding[]> {
  const cfg = substrateChainFor(chainId);
  if (!cfg) throw new Error(`Unknown Substrate chain "${chainId}"`);

  const pubkey = decodeAddress(address);
  const hexKey = accountStorageKey(pubkey);

  const raw = await fetchWithFailover(cfg, hexKey);
  if (!raw) return [];

  const buf = Buffer.from(raw.slice(2), "hex");
  const free = readU128LE(buf, 16);
  if (free <= BigInt(0)) return [];

  const qty = Number(formatUnits(free, cfg.decimals));
  const images = await fetchTokenImages([cfg.nativeCoingeckoId]).catch(() => new Map<string, string>());

  return [
    {
      ticker: cfg.nativeSymbol,
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: cfg.chainSlug,
      icon_url: images.get(cfg.nativeCoingeckoId) ?? null,
    },
  ];
}
