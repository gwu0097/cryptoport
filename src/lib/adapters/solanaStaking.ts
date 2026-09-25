import "server-only";
import { getProgramAccounts, base58encode } from "./solanaRpc";
import { mapWithConcurrency } from "./http";
import { fetchTokenInfo } from "./jupiter";
import { fetchValidatorName } from "./stakewiz";
import type { AdapterHolding } from "./types";

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
// Same wrapped-SOL mint jupiterPositions.ts's resolveAsset uses to look up
// SOL's own icon — reused here via the already-exported fetchTokenInfo
// (also assetPrices.ts's jupiter pricing lane) rather than
// hardcoding an icon URL or adding a second API call for it.
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
// StakeStateV2's own 4-byte enum discriminant for the "Stake" (delegated)
// variant — computed, not hand-copied, same reasoning as every other
// discriminator in this codebase (see wormholeStaking.ts's commit
// comment). Uninitialized/Initialized/RewardsPool accounts are excluded
// by this filter, not just "space === 200" — only a delegated account is
// worth showing as a holding.
const STAKE_VARIANT_DISCRIMINANT = base58encode(Uint8Array.of(2, 0, 0, 0));

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
 * Validator name/APY enrichment is Stakewiz, via the shared
 * fetchValidatorName (stakewiz.ts) — see that file for the free/keyless
 * verification and best-effort-fallback reasoning.
 *
 * protocol_url deliberately points at Marinade's own dApp
 * (app.marinade.finance), not a read-only view — reported directly that
 * the point is a real site to connect the wallet and actually unstake,
 * not just look. Native stake has no single validator-run management
 * site (unlike SKR/Jito, which each have exactly one canonical dApp), but
 * Marinade's own docs confirm its app supports importing/managing an
 * *existing* native delegation to any validator and "instantly unstake
 * from any validator with no platform fees" — verified live (200) —
 * which is the closest real equivalent to a validator-specific unstake
 * page for a mechanism that doesn't otherwise have one.
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
  const [names, tokenInfo] = await Promise.all([
    mapWithConcurrency(distinctVoters, 3, fetchValidatorName),
    fetchTokenInfo([WRAPPED_SOL_MINT]).catch(() => new Map()), // icon is cosmetic — never fail the holding over it
  ]);
  const nameByVoter = new Map(distinctVoters.map((v, i) => [v, names[i]]));
  const solIcon = tokenInfo.get(WRAPPED_SOL_MINT)?.icon ?? null;

  return delegations.map(({ voter, qty }) => ({
    ticker: "SOL",
    qty,
    usd_override: null,
    contract: null,
    category: "defi",
    chain: "solana-defi",
    icon_url: solIcon,
    // One protocol for all native stake (was "Solana Staking: <validator>"
    // per validator until 2026-09-25); the validator is the row label.
    protocol: "Solana native staking",
    protocol_section: "Staked",
    display_label: `Staked · ${nameByVoter.get(voter)}`,
    protocol_url: "https://app.marinade.finance/",
  }));
}
