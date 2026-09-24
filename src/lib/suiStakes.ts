// Sui native staking → holdings (adapters/sui.ts fetches; see suiStakes.test.ts).
// suix_getStakes returns, per validator, the wallet's stake objects: each
// with its principal and (once active) an estimated reward, in MIST (1e-9
// SUI). They're SUI the wallet owns but can't see as a coin balance, so
// they're shown as their own rows: one "Staked" and one "Staking rewards"
// row per validator (the shape wallets like Slush show). Valued as SUI —
// that's exactly what they are.

export interface SuiStakeGroup {
  validatorAddress: string;
  stakes: { principal: string; estimatedReward?: string; status: string }[];
}

export interface SuiStakeHolding {
  ticker: "SUI";
  qty: number;
  usd_override: null;
  contract: null;
  category: "defi";
  chain: "sui";
  icon_url: string | null;
  protocol: string;
  protocol_url: string;
  protocol_section: "Staked" | "Rewards";
  display_label: string;
}

/** MIST (decimal string) → SUI, exact past Number.MAX_SAFE_INTEGER. */
export function mistToSui(mist: bigint): number {
  const scale = BigInt(1_000_000_000);
  return Number(mist / scale) + Number(mist % scale) / 1e9;
}

export function stakesToHoldings(groups: readonly SuiStakeGroup[], validatorNames: ReadonlyMap<string, string>, suiIcon: string | null): SuiStakeHolding[] {
  const out: SuiStakeHolding[] = [];
  for (const g of groups) {
    let principal = BigInt(0);
    let reward = BigInt(0);
    let pending = false;
    for (const s of g.stakes) {
      if (s.status === "Unstaked") continue;
      principal += BigInt(s.principal);
      if (s.estimatedReward) reward += BigInt(s.estimatedReward);
      if (s.status === "Pending") pending = true;
    }
    if (principal === BigInt(0) && reward === BigInt(0)) continue;
    const name = validatorNames.get(g.validatorAddress) ?? `${g.validatorAddress.slice(0, 8)}…${g.validatorAddress.slice(-4)}`;
    const base = {
      ticker: "SUI" as const,
      usd_override: null,
      contract: null,
      category: "defi" as const,
      chain: "sui" as const,
      icon_url: suiIcon,
      protocol: "Sui native staking",
      protocol_url: `https://suiscan.xyz/mainnet/validator/${g.validatorAddress}`,
    };
    if (principal > BigInt(0)) {
      out.push({ ...base, qty: mistToSui(principal), protocol_section: "Staked", display_label: `Staked · ${name}${pending ? " (activates next epoch)" : ""}` });
    }
    if (reward > BigInt(0)) {
      out.push({ ...base, qty: mistToSui(reward), protocol_section: "Rewards", display_label: `Staking rewards · ${name}` });
    }
  }
  return out;
}
