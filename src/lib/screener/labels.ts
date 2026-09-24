// User-facing labels for the Fundamentals (internally "screener") data,
// shared by /screener's tables and the Encyclopedia's Fundamentals tab.
import type { TierValue } from "./queries";

export const TIER_LABEL: Record<TierValue, string> = { pass: "Pass", caution: "Caution", high_risk: "High risk" };
export const TIER_CLASS: Record<TierValue, string> = { pass: "text-fg", caution: "text-warning", high_risk: "text-negative" };

/** Quality & Risk tier rules (config.ts), in plain words. */
export const RULE_LABEL: Record<string, string> = {
  dilution_high: "dilution > 25%/yr",
  unlocks_90d: "unlocks > 5% in 90d",
  revenue_90d_drop: "revenue down > 40% vs prior 90d",
  dilution_caution: "dilution > 10%/yr",
};

/** Kill filters (metrics.ts gate_status keys), in plain words. */
export const GATE_LABEL: Record<string, string> = {
  core_data: "missing data",
  out_of_scope: "out of scope",
  mcap_floor: "mcap < $10M",
  liquidity: "volume < $2M",
  revenue_floor: "revenue < $1M/yr",
  unlock_overhang: "unlock overhang",
  collapsing_revenue: "revenue collapse",
};
