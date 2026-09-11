import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const STAKING_PROGRAM = "MGoV9M6YUsdhJzjzH9JMCW2tRe1LLxF1CjwqKC7DR1B"; // Wormhole MultiGov
// Anchor account discriminator for the staking program's stake-account
// struct — the first 8 bytes of every account this program owns of this
// type, used as a getProgramAccounts filter alongside the owner pubkey.
// Base58-encoded once at module load (not hardcoded as a literal — a
// hand-copied discriminator string is exactly the kind of value that's
// easy to get wrong without noticing, see commit message).
const DISCRIMINATOR = base58encode(Uint8Array.from([68, 11, 237, 138, 61, 33, 15, 93]));
const W_MINT = "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ";
const W_DECIMALS = 6;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(bytes: Uint8Array): string {
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

interface RpcAccount {
  account: { data: [string, string] };
}

interface RpcResponse {
  result?: RpcAccount[];
  error?: { message: string };
}

/**
 * Wormhole's W-token governance staking (the "MultiGov" program) — not
 * documented as a public API anywhere (checked: no endpoint on
 * wormhole.com, MultiGov's own docs, or Wormholescan, which is only for
 * cross-chain message tracking). Reads the on-chain stake account
 * directly instead: one account per staker, found via
 * getProgramAccounts filtered by this program's account discriminator
 * (offset 0) and the staker's own pubkey (offset 27), decoded from the
 * fixed 93-byte struct. Cross-checked byte-for-byte against a real wallet
 * before shipping — see commit message.
 *
 * Struct layout (all little-endian):
 *   0-7   discriminator (8 bytes)
 *   8-10  bumps (3 bytes, unused here)
 *   11-18 recorded_balance: u64, W's own decimals (6)
 *   19-26 recorded_vesting_balance: u64 (unused — vesting, not staked, W)
 *   27-58 owner: pubkey (32 bytes)
 *   59-90 delegate: pubkey (32 bytes, unused here)
 *
 * No legacy-program fallback (an older staking program existed pre-
 * MultiGov) — out of scope unless it turns out to matter for a real
 * wallet, since MultiGov is the current, actively-used program.
 */
export async function fetchWormholeStaking(address: string): Promise<AdapterHolding[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      STAKING_PROGRAM,
      {
        encoding: "base64",
        filters: [
          { memcmp: { offset: 0, bytes: DISCRIMINATOR } },
          { memcmp: { offset: 27, bytes: address } },
        ],
      },
    ],
  };

  const res = await fetchWithRetry(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Wormhole staking lookup failed: HTTP ${res.status}`);
  const json: RpcResponse = await res.json();
  if (json.error) throw new Error(`Wormhole staking lookup failed: ${json.error.message}`);

  const accounts = json.result ?? [];
  if (accounts.length === 0) return []; // no stake account for this wallet — a real $0, not an error

  const buf = Buffer.from(accounts[0].account.data[0], "base64");
  const recordedBalance = buf.readBigUInt64LE(11);
  const qty = Number(recordedBalance) / 10 ** W_DECIMALS;
  if (qty <= 0) return [];

  return [
    {
      ticker: "W",
      qty,
      usd_override: null,
      contract: W_MINT,
      category: "defi",
      chain: "solana-defi",
      icon_url: null,
      protocol: "Wormhole Staking",
      protocol_url: "https://w.wormhole.com/",
    },
  ];
}
