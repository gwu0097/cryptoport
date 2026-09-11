import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const PROGRAM = "3parcLrT7WnXAcyPfkCz49oofuuf2guUKkjuFkAhZW8Y"; // Parcl v3
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Exchange id 0's collateral — verified on-chain
const USDC_DECIMALS = 6;
const APP_URL = "https://app.parcl.co/";

// Anchor discriminator for Parcl's MarginAccount struct — computed from the
// same byte array Parcl's own SDK source uses (ParclFinance/v3-sdk-ts,
// src/types/accounts/serializers/marginAccount.ts's account discriminator),
// not hand-copied as a base58 string (see wormholeStaking.ts's commit
// message for why that's worth avoiding).
const DISCRIMINATOR = base58encode(Uint8Array.from([133, 220, 173, 213, 179, 211, 43, 238]));

// MarginAccount layout, sourced directly from Parcl's own SDK
// (src/types/accounts/serializers/marginAccount.ts) and independently
// confirmed byte-for-byte against a real account before shipping (a real
// account's on-chain size is exactly 904 bytes, matching this layout
// exactly — see commit message):
//   0-7     discriminator (8)
//   8-775   positions[12], 64 bytes each (768) — each: size i128(16) @ 0,
//           lastInteractionPrice u128(16), a packed PreciseInt(24), marketId
//           u32(4), padding(4)
//   776-783 margin: u64 (settled/idle collateral, USDC, 6 decimals)
//   784-791 maxLiquidationFee: u64 (unused here)
//   792-795 id: u32 (unused here)
//   796-827 exchange: pubkey (unused here — this app only reads the one
//           USDC-collateral exchange Parcl v3 currently runs)
//   828-859 owner: pubkey — the getProgramAccounts filter below
const POSITIONS_OFFSET = 8;
const POSITION_SIZE = 64;
const POSITION_COUNT = 12;
const MARGIN_OFFSET = 776;
const OWNER_OFFSET = 828;

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
  pubkey: string;
  account: { data: [string, string] };
}

interface RpcResponse {
  result?: RpcAccount[];
  error?: { message: string };
}

export interface ParclPositionsResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

/**
 * Parcl v3 (real-estate index perpetuals on Solana) has no HTTP API at all
 * — confirmed: docs.parcl.co and their SDK repo document only on-chain
 * program accounts. ("Parcl Labs API" at docs.parcllabs.com is a same-name,
 * unrelated paid housing-data product — not this.) Reads a wallet's margin
 * accounts (one Anchor PDA per account the wallet has opened) directly via
 * getProgramAccounts, decoded from the raw struct rather than the official
 * `@parcl-oss/v3-sdk` npm package — that package pulls in
 * @coral-xyz/anchor, @metaplex-foundation/umi, and Pyth clients for a
 * single small niche feature, hasn't published since April 2025, and is
 * still at v0.0.x; the same "heavy, stale dependency for one feature" red
 * flag that got @sonarwatch/portfolio-plugins rejected earlier (see commit
 * message) — not worth it here either given the account layout is simple
 * enough to decode directly and was verified byte-for-byte.
 *
 * Only reports `margin` — a margin account's settled/idle USDC collateral,
 * a real token with a real, already-priced ticker. Deliberately does NOT
 * attempt to price open positions' unrealized PnL: that requires decoding
 * a Pyth price-oracle account per open position, which wasn't verified
 * (the wallet this was built against has zero open positions right now,
 * so there was nothing real to verify that decode against) — a wallet
 * with an open position gets a `warnings` entry instead of a silently
 * wrong/incomplete number.
 */
export async function fetchParclPositions(address: string): Promise<ParclPositionsResult> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      PROGRAM,
      {
        encoding: "base64",
        filters: [
          { memcmp: { offset: 0, bytes: DISCRIMINATOR } },
          { memcmp: { offset: OWNER_OFFSET, bytes: address } },
        ],
      },
    ],
  };

  const res = await fetchWithRetry(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Parcl margin account lookup failed: HTTP ${res.status}`);
  const json: RpcResponse = await res.json();
  if (json.error) throw new Error(`Parcl margin account lookup failed: ${json.error.message}`);

  const accounts = json.result ?? [];
  const holdings: AdapterHolding[] = [];
  let openPositionCount = 0;

  for (const acc of accounts) {
    const buf = Buffer.from(acc.account.data[0], "base64");
    const margin = buf.readBigUInt64LE(MARGIN_OFFSET);

    for (let i = 0; i < POSITION_COUNT; i++) {
      const sizeStart = POSITIONS_OFFSET + i * POSITION_SIZE;
      const sizeBytes = buf.subarray(sizeStart, sizeStart + 16); // i128 size field
      if (!sizeBytes.every((b) => b === 0)) openPositionCount += 1;
    }

    const qty = Number(margin) / 10 ** USDC_DECIMALS;
    if (qty <= 0) continue;
    holdings.push({
      ticker: "USDC",
      qty,
      usd_override: null,
      contract: USDC_MINT,
      category: "defi",
      chain: "solana-defi",
      icon_url: null,
      protocol: "Parcl",
      protocol_url: APP_URL,
    });
  }

  const warnings =
    openPositionCount > 0
      ? [
          `parcl: ${openPositionCount} open position(s) found but not priced (unrealized PnL requires a Pyth price decode this adapter doesn't do) — only settled margin is included`,
        ]
      : [];

  return { holdings, warnings };
}
