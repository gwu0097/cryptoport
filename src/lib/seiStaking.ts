// Sei native staking → holdings (adapters/seiStaking.ts fetches; see
// seiStaking.test.ts). Sei staking lives on the Cosmos side, keyed by the
// sei1… address, so an EVM (0x) wallet's sync never saw it (reported
// 2026-09-24: a former Compass wallet's 1,020 SEI staked + 75.97 SEI rewards
// were missing). Rows per validator: "Staked" and "Staking rewards", plus
// "Unbonding" for undelegations still inside Sei's unbonding period. All in
// usei (1e-6 SEI). Valued as SEI, at the same per-unit price as the wallet's
// own native balance when there is one.

export interface SeiStakingData {
  delegations: { validator: string; amountUsei: string }[];
  rewards: { validator: string; amountUsei: string }[]; // DecCoin strings, may have decimals
  unbonding: { validator: string; amountUsei: string; completionTime: string }[];
}

export interface SeiStakeHolding {
  ticker: "SEI";
  qty: number;
  usd_override: number | null;
  contract: null;
  category: "defi";
  chain: "sei";
  icon_url: string | null;
  protocol: "Sei native staking";
  protocol_url: string;
  protocol_section: "Staked" | "Rewards" | "Unbonding";
  display_label: string;
}

const useiToSei = (v: string) => Number(v) / 1e6;

export function seiStakingHoldings(data: SeiStakingData, monikers: ReadonlyMap<string, string>, unitUsd: number | null, icon: string | null): SeiStakeHolding[] {
  const name = (v: string) => monikers.get(v) ?? `${v.slice(0, 14)}…${v.slice(-4)}`;
  const row = (validator: string, qty: number, section: SeiStakeHolding["protocol_section"], label: string): SeiStakeHolding => ({
    ticker: "SEI",
    qty,
    usd_override: unitUsd === null ? null : qty * unitUsd,
    contract: null,
    category: "defi",
    chain: "sei",
    icon_url: icon,
    protocol: "Sei native staking",
    protocol_url: `https://www.mintscan.io/sei/validators/${validator}`,
    protocol_section: section,
    display_label: label,
  });
  const out: SeiStakeHolding[] = [];
  for (const d of data.delegations) {
    const qty = useiToSei(d.amountUsei);
    if (qty > 0) out.push(row(d.validator, qty, "Staked", `Staked · ${name(d.validator)}`));
  }
  for (const r of data.rewards) {
    const qty = useiToSei(r.amountUsei);
    if (qty >= 1e-6) out.push(row(r.validator, qty, "Rewards", `Staking rewards · ${name(r.validator)}`));
  }
  for (const u of data.unbonding) {
    const qty = useiToSei(u.amountUsei);
    if (qty > 0) out.push(row(u.validator, qty, "Unbonding", `Unbonding · ${name(u.validator)} · available ${u.completionTime.slice(0, 10)}`));
  }
  return out;
}
