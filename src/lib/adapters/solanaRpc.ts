import "server-only";
import { fetchWithRetry } from "./http";

const RPC_URL = "https://api.mainnet-beta.solana.com";

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
