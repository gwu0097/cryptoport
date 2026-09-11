import "server-only";
import { createHash } from "node:crypto";
import { getProgramAccounts, base58encode } from "./solanaRpc";
import type { AdapterHolding } from "./types";

// Jupiter's own fork of Tribeca's locked_voter program (not the shared
// Tribeca deployment — that one has zero JUP lockers). Found via vote.jup.ag's
// JS bundle, confirmed live on-chain.
const PROGRAM = "voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj";
// The one Locker account for JUP itself — the locked_voter program hosts
// 13 different Lockers total (other Jupiter products/DAOs reuse the same
// program), so this specific address matters; verified live: its
// token_mint is JUP's own mint.
const LOCKER = "CVMdMd79no569tjc5Sq7kzz8isbfCcFyBS5TLGsrZ5dN";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const JUP_DECIMALS = 6;
const APP_URL = "https://vote.jup.ag/";

// Anchor account discriminator = first 8 bytes of sha256("account:<Name>")
// — computed here, not hand-copied as a base58 literal (see
// wormholeStaking.ts's commit message for why a hand-copied discriminator
// is worth avoiding). Verified live: filtering getProgramAccounts by just
// this discriminator returns exactly the escrow accounts.
function anchorDiscriminatorB58(accountName: string): string {
  const hash = createHash("sha256").update(`account:${accountName}`).digest();
  return base58encode(hash.subarray(0, 8));
}

const ESCROW_DISCRIMINATOR = anchorDiscriminatorB58("Escrow");

/**
 * Jupiter DAO governance — locked/staked JUP for voting power. No public
 * API covers this: Jupiter's own positions API (api.jup.ag/portfolio)
 * lists "jupiter-governance" as a registered platform id but never
 * actually invokes a fetcher for it (confirmed: no fetcherReport entry at
 * all, success or failure, for a wallet the jup.ag WEBSITE shows has a
 * real Jupiter DAO position). Reads the on-chain "Escrow" account
 * directly instead — found via getProgramAccounts filtered by account
 * discriminator + the DAO's one Locker address + the wallet's own pubkey,
 * the same technique as wormholeStaking.ts/parclPositions.ts, deliberately
 * avoiding needing to derive the escrow's PDA (which would need real
 * ed25519 curve-point math this app has no dependency for) — filtering by
 * the fields a PDA derivation would have produced anyway finds the exact
 * same account.
 *
 * Cross-checked two ways before shipping: the escrow's own `amount` field
 * (offset 105, u64) and the SPL balance of the token vault it points at
 * (offset 73) agree exactly for a real wallet — see commit message.
 *
 * `isMaxLock` (offset 161) isn't surfaced — when true (the common case,
 * required for Jupiter's staking rewards), `escrowEndsAt` is stale
 * bookkeeping rather than a real unlock date, so there's nothing reliable
 * to show beyond the locked amount itself.
 */
export async function fetchJupiterDaoStaking(address: string): Promise<AdapterHolding[]> {
  const accounts = await getProgramAccounts(
    PROGRAM,
    [
      { memcmp: { offset: 0, bytes: ESCROW_DISCRIMINATOR } },
      { memcmp: { offset: 8, bytes: LOCKER } },
      { memcmp: { offset: 40, bytes: address } },
    ],
    "Jupiter DAO escrow lookup",
  );
  if (accounts.length === 0) return []; // never locked JUP — a real $0, not an error

  const buf = Buffer.from(accounts[0].account.data[0], "base64");
  const amount = buf.readBigUInt64LE(105);
  const qty = Number(amount) / 10 ** JUP_DECIMALS;
  if (qty <= 0) return [];

  return [
    {
      ticker: "JUP",
      qty,
      usd_override: null,
      contract: JUP_MINT,
      category: "defi",
      chain: "solana-defi",
      icon_url: null,
      protocol: "Jupiter DAO",
      protocol_url: APP_URL,
    },
  ];
}
