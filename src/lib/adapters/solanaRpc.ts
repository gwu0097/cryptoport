import "server-only";
import { fetchWithRetry, mapWithConcurrency } from "./http";

const RPC_URL = "https://api.mainnet-beta.solana.com";
// Solana RPC's own hard limit on how many pubkeys getMultipleAccounts
// accepts per call — not a tunable, a protocol constant.
const MAX_ACCOUNTS_PER_CALL = 100;
// Same rate-limit caution as prices.ts's COINBASE_CONCURRENCY — this app's
// public RPC has already 429'd under an unbounded burst once (see
// getProgramAccounts' own callers), so any batched call here stays capped
// by construction rather than by hoping.
const ACCOUNTS_CONCURRENCY = 4;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58-encodes raw bytes — used to turn an Anchor account discriminator
 * (computed from its own byte source at each caller, not hand-copied as a
 * base58 literal — a hand-copied discriminator string is exactly the kind
 * of value that's easy to get wrong without noticing) into the string form
 * getProgramAccounts' memcmp filters expect. */
export function base58encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (let k = 0; bytes[k] === 0 && k < bytes.length - 1; k++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--) result += ALPHABET[digits[i]];
  return result;
}

export interface RpcAccount {
  pubkey?: string;
  account: { data: [string, string] };
}

interface RpcResponse {
  result?: RpcAccount[];
  error?: { message: string };
}

export interface GetProgramAccountsFilter {
  memcmp: { offset: number; bytes: string };
}

/**
 * getProgramAccounts against Solana's public mainnet RPC, base64-encoded —
 * the shared request/response wrapper that three on-chain-only DeFi
 * adapters (parclPositions.ts, wormholeStaking.ts, jupiterDaoStaking.ts)
 * used to each reimplement near-verbatim (one of their own doc comments
 * already admitted as much: "the same technique as wormholeStaking.ts/
 * parclPositions.ts"). `context` only labels a failure's error message
 * with which adapter/program it came from — this function itself has no
 * idea what the accounts it returns mean, that's each caller's own
 * account-layout decoding.
 */
export async function getProgramAccounts(
  program: string,
  filters: GetProgramAccountsFilter[],
  context: string,
): Promise<RpcAccount[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [program, { encoding: "base64", filters }],
  };

  const res = await fetchWithRetry(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${context} failed: HTTP ${res.status}`);
  const json: RpcResponse = await res.json();
  if (json.error) throw new Error(`${context} failed: ${json.error.message}`);
  return json.result ?? [];
}

/** A single getMultipleAccounts entry — null when that pubkey doesn't
 * exist on-chain (e.g. rent-reclaimed, or never created). */
export type RpcAccountInfo = { data: [string, string] } | null;

interface MultipleAccountsResponse {
  result?: { value: RpcAccountInfo[] };
  error?: { message: string };
}

async function getMultipleAccountsChunk(pubkeys: string[], context: string): Promise<RpcAccountInfo[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [pubkeys, { encoding: "base64" }],
  };
  const res = await fetchWithRetry(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${context} failed: HTTP ${res.status}`);
  const json: MultipleAccountsResponse = await res.json();
  if (json.error) throw new Error(`${context} failed: ${json.error.message}`);
  return json.result?.value ?? [];
}

/**
 * getMultipleAccounts against the same public RPC getProgramAccounts
 * above uses — transparently chunked at 100 pubkeys/call (Solana RPC's
 * own hard limit) and concurrency-capped, so a caller with hundreds or
 * low-thousands of pubkeys (jitoMevRewards.ts's on-chain claim-status
 * check) never has to know about either constraint itself. Result order
 * matches the input order 1:1, same as the raw RPC response's own `value`
 * array — a null entry means that pubkey doesn't exist on-chain.
 */
export async function getMultipleAccounts(pubkeys: string[], context: string): Promise<RpcAccountInfo[]> {
  if (pubkeys.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < pubkeys.length; i += MAX_ACCOUNTS_PER_CALL) {
    chunks.push(pubkeys.slice(i, i + MAX_ACCOUNTS_PER_CALL));
  }
  const results = await mapWithConcurrency(chunks, ACCOUNTS_CONCURRENCY, (chunk) =>
    getMultipleAccountsChunk(chunk, context),
  );
  return results.flat();
}
