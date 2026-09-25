// Sui native staking → holdings (adapters/sui.ts fetches via GraphQL; see suiStakes.test.ts).
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
/** Sui's GraphQL API writes system packages in full ("0x000…0002::sui::SUI");
 * holdings have always stored them short ("0x2::sui::SUI", what JSON-RPC
 * returned), so a row keeps its identity across the switch. */
export function normalizeSuiCoinType(repr: string): string {
  return repr.replace(/^0x0{63}([1-3])::/, "0x$1::");
}

/** A stake's accrued reward, in MIST: its pool tokens (principal at the
 * pool's exchange rate in its activation epoch) valued at the pool's
 * current rate, minus the principal — the same calculation Sui's staking
 * contract uses on withdrawal. Never negative. */
export function estimateStakeReward(
  principal: bigint,
  atActivation: { sui_amount: string; pool_token_amount: string },
  pool: { sui_balance: string; pool_token_balance: string },
): bigint {
  const sa = BigInt(atActivation.sui_amount);
  const pta = BigInt(atActivation.pool_token_amount);
  const sb = BigInt(pool.sui_balance);
  const ptb = BigInt(pool.pool_token_balance);
  if (sa === BigInt(0) || ptb === BigInt(0)) return BigInt(0);
  const tokens = (principal * pta) / sa;
  const now = (tokens * sb) / ptb;
  return now > principal ? now - principal : BigInt(0);
}

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
