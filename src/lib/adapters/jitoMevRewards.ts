import "server-only";
import { fetchWithRetry } from "./http";
import { getMultipleAccounts } from "./solanaRpc";
import { fetchValidatorName } from "./stakewiz";
import { fetchTokenInfo } from "./jupiter";
import type { AdapterHolding } from "./types";

const KOBE_BASE = "https://kobe.mainnet.jito.network";
const PAGE_LIMIT = 10000; // the API's own documented max
// Same wrapped-SOL mint solanaStaking.ts uses to look up SOL's own icon —
// reused here rather than hardcoded or re-fetched a different way.
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

interface StakerReward {
  validator_vote_account: string;
  amount: number; // lamports
  claim_status_account: string;
  priority_fee_amount: number | null; // lamports
  priority_fee_claim_status_account: string | null;
}

interface StakerRewardsResponse {
  rewards: StakerReward[];
}

async function fetchAllRewards(address: string): Promise<StakerReward[]> {
  const all: StakerReward[] = [];
  let page = 1;
  for (;;) {
    const url = `${KOBE_BASE}/api/v1/staker_rewards?stake_authority=${address}&limit=${PAGE_LIMIT}&page=${page}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Jito staker_rewards failed: HTTP ${res.status}`);
    const body: StakerRewardsResponse = await res.json();
    all.push(...body.rewards);
    // total_count isn't reliably populated (seen 0 even with real rows
    // present), so pagination is driven by whether this page came back
    // full rather than trusting it.
    if (body.rewards.length < PAGE_LIMIT) break;
    page++;
  }
  return all;
}

interface ClaimableItem {
  voter: string;
  lamports: number;
  claimStatusAccount: string;
}

/**
 * Claimable-but-unclaimed Jito MEV tip rewards — the mechanism behind
 * jup.ag's "Jito" tile ("Claimable $X"), a completely different thing
 * from native validator staking (see solanaStaking.ts): every epoch, a
 * validator's MEV tips get distributed to its stakers via a merkle-tree
 * airdrop, claimable any time after the root is uploaded. Nothing expires
 * this automatically, so a wallet that's staked for a while can have
 * thousands of small unclaimed records sitting open — verified live
 * against a real wallet: 1,975 historical reward records back to epoch
 * 843, of which 1,868 were still unclaimed (~0.396 SOL) and 107 already
 * claimed.
 *
 * Two real API/on-chain lookups, not one:
 * 1. Jito's own kobe.mainnet.jito.network/api/v1/staker_rewards (free,
 *    keyless, documented) lists every historical reward for a
 *    `stake_authority` — but does NOT say which are still claimable.
 * 2. Each reward names its own `claim_status_account` — a ClaimStatus
 *    account (owned by Jito's Tip Distribution program,
 *    4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7) that only gets created/
 *    flipped once someone actually claims it. Byte offset 8 (right after
 *    the standard 8-byte Anchor discriminator) is a bool `is_claimed` —
 *    verified live by decoding real accounts: 1 = claimed, and a pubkey
 *    with no account at all (RPC returns null) is equally unclaimed (the
 *    claim never happened, nothing to flip). Checked in bulk via the
 *    shared getMultipleAccounts (solanaRpc.ts), which already handles the
 *    100-per-call batching and concurrency cap — this is the heaviest of
 *    every solDefiPositions source (hundreds to low-thousands of accounts
 *    for a long-time staker), isolated the same way every other source
 *    here is: a failure becomes a warning, never fails the wallet's sync.
 *
 * Grouped and summed per validator (not one holding per reward record —
 * with up to ~2000 individual epoch-level records, that would be an
 * unusable table), same mental model as solanaStaking.ts's per-validator
 * breakdown. `priority_fee_amount`/`priority_fee_claim_status_account`
 * (a separate, optional claimable pool per reward record — empty for
 * every record tested live, but handled generically) are summed in the
 * same pass, not as a second lookup.
 */
export async function fetchJitoMevRewards(address: string): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const rewards = await fetchAllRewards(address);
  if (rewards.length === 0) return { holdings: [], warnings: [] };

  const items: ClaimableItem[] = [];
  for (const r of rewards) {
    items.push({ voter: r.validator_vote_account, lamports: r.amount, claimStatusAccount: r.claim_status_account });
    if (r.priority_fee_amount && r.priority_fee_claim_status_account) {
      items.push({
        voter: r.validator_vote_account,
        lamports: r.priority_fee_amount,
        claimStatusAccount: r.priority_fee_claim_status_account,
      });
    }
  }

  const claimStatusAccounts = [...new Set(items.map((i) => i.claimStatusAccount))];
  const accountInfos = await getMultipleAccounts(claimStatusAccounts, "Jito claim status lookup");
  const claimedByAccount = new Map<string, boolean>();
  claimStatusAccounts.forEach((pubkey, i) => {
    const info = accountInfos[i];
    // No account at all means the claim was never made — unclaimed, not
    // an error. is_claimed lives right after the 8-byte discriminator.
    const isClaimed = info !== null && Buffer.from(info.data[0], "base64").readUInt8(8) === 1;
    claimedByAccount.set(pubkey, isClaimed);
  });

  const unclaimedByValidator = new Map<string, number>();
  for (const item of items) {
    if (claimedByAccount.get(item.claimStatusAccount)) continue;
    unclaimedByValidator.set(item.voter, (unclaimedByValidator.get(item.voter) ?? 0) + item.lamports);
  }
  if (unclaimedByValidator.size === 0) return { holdings: [], warnings: [] };

  const distinctVoters = [...unclaimedByValidator.keys()];
  const [names, tokenInfo] = await Promise.all([
    Promise.all(distinctVoters.map(fetchValidatorName)),
    fetchTokenInfo([WRAPPED_SOL_MINT]).catch(() => new Map()), // icon is cosmetic — never fail over it
  ]);
  const nameByVoter = new Map(distinctVoters.map((v, i) => [v, names[i]]));
  const solIcon = tokenInfo.get(WRAPPED_SOL_MINT)?.icon ?? null;

  const holdings: AdapterHolding[] = distinctVoters.map((voter) => ({
    ticker: "SOL",
    qty: unclaimedByValidator.get(voter)! / 1e9,
    usd_override: null,
    contract: null,
    category: "defi",
    chain: "solana-defi",
    icon_url: solIcon,
    protocol: `Jito MEV Rewards: ${nameByVoter.get(voter)}`,
    protocol_url: "https://www.jito.network/",
  }));

  return { holdings, warnings: [] };
}
