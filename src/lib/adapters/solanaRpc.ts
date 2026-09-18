import "server-only";
import { fetchWithRetry, mapWithConcurrency } from "./http";

const RPC_URL = "https://api.mainnet-beta.solana.com";
// Solana RPC's own hard limit on how many pubkeys getMultipleAccounts
// accepts per call — not a tunable, a protocol constant.
const MAX_ACCOUNTS_PER_CALL = 100;
// Same rate-limit caution as prices.ts's COINBASE_CONCURRENCY — bounds how
// many chunk-fetches getMultipleAccounts itself tries to have in flight;
// see RPC_CONCURRENCY below for the *global* gate that actually matters.
const ACCOUNTS_CONCURRENCY = 4;

// This file is now called concurrently by seven independent adapters
// (wormholeStaking/jupiterDaoStaking/parclPositions/solanaStaking/
// skrStaking's own getProgramAccounts calls, plus jitoMevRewards' many
// getMultipleAccounts batches) via solDefiPositions.ts's own Promise.all
// fan-out over every SOL DeFi source at once. Each caller was already
// individually rate-limit-safe (fetchWithRetry's backoff, this file's own
// ACCOUNTS_CONCURRENCY), but nothing capped the *combined* burst across
// all of them hitting this one shared public endpoint simultaneously —
// live-verified this causes real, intermittent 429s severe enough that
// fetchWithRetry's built-in backoff doesn't always absorb them within its
// own attempt budget. Every actual HTTP request this file makes — from
// getProgramAccounts and getMultipleAccounts alike — funnels through this
// one queue, so the true in-flight request count against
// api.mainnet-beta.solana.com never exceeds RPC_CONCURRENCY no matter how
// many unrelated adapters are calling in at once.
const RPC_CONCURRENCY = 3;
let activeRpcCalls = 0;
const rpcQueue: (() => void)[] = [];

async function withRpcSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRpcCalls >= RPC_CONCURRENCY) {
    await new Promise<void>((resolve) => rpcQueue.push(resolve));
  }
  activeRpcCalls++;
  try {
    return await fn();
  } finally {
    activeRpcCalls--;
    rpcQueue.shift()?.();
  }
}

/** The one place either RPC method actually sends a request — concurrency-
 * gated (withRpcSlot) and given more retry headroom than fetchWithRetry's
 * own default (3 attempts / 1s base): even with the gate in place, this
 * shared endpoint still 429'd under real multi-source concurrent load
 * during testing, so this gets 5 attempts and a slower backoff — a queued
 * request that has to wait its turn already accepts some latency, so
 * trading a bit more of it for reliability here is the right side of that
 * tradeoff. */
async function rpcFetch(body: unknown): Promise<Response> {
  return withRpcSlot(() =>
    fetchWithRetry(
      RPC_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      { attempts: 5, baseDelayMs: 1500 },
    ),
  );
}

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

  const res = await rpcFetch(body);
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
  const res = await rpcFetch(body);
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
