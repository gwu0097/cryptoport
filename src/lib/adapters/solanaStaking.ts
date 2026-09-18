import "server-only";
import { getProgramAccounts, base58encode } from "./solanaRpc";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import type { AdapterHolding } from "./types";

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
// StakeStateV2's own 4-byte enum discriminant for the "Stake" (delegated)
// variant — computed, not hand-copied, same reasoning as every other
// discriminator in this codebase (see wormholeStaking.ts's commit
// comment). Uninitialized/Initialized/RewardsPool accounts are excluded
// by this filter, not just "space === 200" — only a delegated account is
// worth showing as a holding.
const STAKE_VARIANT_DISCRIMINANT = base58encode(Uint8Array.of(2, 0, 0, 0));

const STAKEWIZ_BASE = "https://api.stakewiz.com";
// u64::MAX — this codebase targets ES2017, so BigInt literals (18446744...n)
// aren't available; every other adapter here builds bigints via BigInt(...)
// calls for the same reason (see multicallEvm.ts/substrate.ts).
const NOT_DEACTIVATING = BigInt("0xffffffffffffffff");

interface Delegation {
  voter: string;
  qty: number;
}

/**
 * Native Solana validator staking — delegating SOL directly via Solana's
 * built-in Stake program, the mechanism behind jup.ag's own "Validators"
 * tab. Not covered by Jupiter's portfolio API at all (confirmed live:
 * api.jup.ag/portfolio/v1/platforms lists only Jupiter's own 8 products —
 * see jupiterPositions.ts's own doc comment), so this reads the on-chain
 * stake accounts directly, the same getProgramAccounts+memcmp technique as
 * wormholeStaking.ts/jupiterDaoStaking.ts/parclPositions.ts.
 *
 * One stake account per delegation (a wallet can have many, one per
 * validator or even several to the same validator) — filtered by the
 * withdrawer-authority field (offset 44) matching this address, which
 * covers every stake account a typical wallet created for itself (staker
 * and withdrawer are the same address unless deliberately split, which
 * this app has no way to detect/support anyway). One holding per account,
 * matching jup.ag's own per-account breakdown, not aggregated per
 * validator — DefiTable already groups by `protocol`, so every account
 * delegated to the same validator lands under the same group naturally.
 *
 * StakeStateV2 layout (bincode, fixed 200 bytes), byte-for-byte verified
 * against a real wallet before shipping (see commit message):
 *   0-3     enum discriminant (u32 LE) — 2 = "Stake" (delegated)
 *   12-43   meta.authorized.staker (pubkey)
 *   44-75   meta.authorized.withdrawer (pubkey) — filtered on this
 *   124-155 stake.delegation.voter_pubkey (pubkey) — the validator
 *   156-163 stake.delegation.stake (u64 LE, lamports)
 *   172-179 stake.delegation.deactivation_epoch (u64 LE) — u64::MAX means
 *           "not deactivating"; anything else means this stake is
 *           unwinding, no longer a real ongoing position
 *
 * Validator name/APY enrichment comes from Stakewiz (api.stakewiz.com,
 * free, keyless, tested live — /validator/{vote_identity} returns
 * `name`/`total_apy`, verified against a real wallet: "Solana Mobile
 * Validator", 5.26% APY, matching jup.ag exactly). Best-effort only: a
 * Stakewiz failure (down, rate-limited, or an obscure validator with no
 * wiz data — its API returns bare `false` rather than 404 for an unknown
 * vote pubkey, not an error status) degrades to a plain truncated-pubkey
 * label rather than dropping the holding — this is real money delegated
 * on-chain, an enrichment-label failure must never make it disappear.
 */
export async function fetchSolanaStaking(address: string): Promise<AdapterHolding[]> {
  const accounts = await getProgramAccounts(
    STAKE_PROGRAM,
    [
      { memcmp: { offset: 0, bytes: STAKE_VARIANT_DISCRIMINANT } },
      { memcmp: { offset: 44, bytes: address } },
    ],
    "Solana stake account lookup",
  );

  const delegations: Delegation[] = [];
  for (const a of accounts) {
    const buf = Buffer.from(a.account.data[0], "base64");
    const deactivationEpoch = buf.readBigUInt64LE(172);
    if (deactivationEpoch !== NOT_DEACTIVATING) continue; // unwinding, not an ongoing position
    const lamports = buf.readBigUInt64LE(156);
    const qty = Number(lamports) / 1e9;
    if (qty <= 0) continue;
    delegations.push({ voter: base58encode(buf.subarray(124, 156)), qty });
  }
  if (delegations.length === 0) return []; // no active stake — a real $0, not an error

  const distinctVoters = [...new Set(delegations.map((d) => d.voter))];
  const labels = await mapWithConcurrency(distinctVoters, 3, fetchValidatorLabel);
  const labelByVoter = new Map(distinctVoters.map((v, i) => [v, labels[i]]));

  return delegations.map(({ voter, qty }) => ({
    ticker: "SOL",
    qty,
    usd_override: null,
    contract: null,
    category: "defi",
    chain: "solana-defi",
    icon_url: null,
    protocol: labelByVoter.get(voter)!,
    protocol_url: `https://stakewiz.com/validator/${voter}`,
  }));
}

async function fetchValidatorLabel(voter: string): Promise<string> {
  try {
    const res = await fetchWithRetry(`${STAKEWIZ_BASE}/validator/${voter}`);
    if (res.ok) {
      const body: { name?: string; total_apy?: number } | false = await res.json();
      if (body && body.name) {
        const apy = typeof body.total_apy === "number" ? ` (${body.total_apy.toFixed(2)}% APY)` : "";
        return `Solana Staking: ${body.name}${apy}`;
      }
    }
  } catch {
    // best-effort — fall through to the truncated-pubkey label below
  }
  return `Solana Staking: ${voter.slice(0, 4)}…${voter.slice(-4)}`;
}
