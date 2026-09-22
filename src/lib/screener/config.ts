// The screener's single config file (build-prompt principle #9: "all
// thresholds and weights live in one config file"). Pure — no DB/network —
// so it's unit-testable and hashable (config.test.ts). Every live run stamps
// its derived rows with the screener_scoring_config_versions row matching
// this file's hash (see derive.ts), so any metric/regime row is traceable to
// the exact thresholds that produced it.
//
// Changing anything here creates a new config version on the next run — the
// intended way to change a threshold. Candidate-factor weights change only
// with Phase 4 evidence (validateConfig enforces evidence_ref for "active").

import { createHash } from "node:crypto";

export type SectorBucket =
  | "lending"
  | "perps_dex"
  | "launchpad_trading_apps"
  | "liquid_staking"
  | "yield"
  | "oracles_infra"
  | "out_of_scope"
  | "other";

export interface CandidateFactor {
  factor: "ps" | "pf" | "buyback_yield" | "dilution_rate";
  weight: number; // 0 until "active"
  status: "candidate" | "active" | "rejected";
  evidence_ref: string | null; // required non-null to be "active" — enforced by validateConfig
  changed_at: string;
  note: string;
}

export interface HolderValueMechanism {
  status: "active" | "paused" | "conditional";
  mechanism: string;
  sourceUrls: string[];
  /** Latest date a cited source shows this status — not the date it was
   * typed in. Display only: value capture is not a tier input. */
  as_of: string;
}

export const SCREENER_CONFIG = {
  /** Source conflicts (e.g. DefiLlama vs CoinGecko mcap) above this % are
   * flagged, never silently resolved (principle #4). */
  conflictThresholdPct: 5,

  /** Kill filters: a "fail" makes an asset UNRATED (kept, with the reason —
   * never dropped). A gate whose input is null is "not_evaluable" and does
   * not fail (absence of data is not evidence). */
  gates: {
    mcapFloorUsd: 10_000_000, // lowered from $100M at Phase 1 sign-off
    minVolume24hUsd: 2_000_000,
    /** Lowered from $5M to $1M, decided 2026-09-22 (Phase 2a sign-off): at
     * $5M only 53 assets were rated — too thin for min-4-per-sector
     * percentiles and Phase 4's statistical power; $1M rates 85. */
    minRevenueAnnualizedUsd: 1_000_000,
    /** Needs real forward unlock data (screener_manual_unlocks, not built);
     * no data = not_evaluable, never pass or fail. */
    unlockOverhang90d: { unratedAbove: 0.1, flagAbove: 0.05 },
    /** 90d revenue vs prior 90d — evaluated from Phase 2b. */
    collapsingRevenue90d: { unratedBelow: -0.6 },
  },

  /** Quality & Risk tier (Pass / Caution / High risk), worst tier wins —
   * evaluated in Phase 3; thresholds live here. Decided 2026-09-22:
   * - Unlock status UNKNOWN is a display flag, never a tier trigger; only
   *   real unlock data triggers tiers.
   * - A rule with a null input does not fire; per-asset rule coverage is
   *   stored and shown next to the tier.
   * - Value capture is not a tier input at all (incl. staleness) — a
   *   documented buyback must never lower a tier.
   * - dilution_rate triggers tiers only when MEASURED from live supply
   *   snapshots; dilution_rate_implied (backfilled mcap ÷ price) is display
   *   only. */
  tiers: {
    highRisk: { dilutionRateAbove: 0.25, unlocks90dPctOfCirculatingAbove: 0.05, revenue90dChangeBelow: -0.4 },
    caution: { dilutionRateAbove: 0.1 },
  },

  candidateFactors: [
    { factor: "ps", weight: 0, status: "candidate", evidence_ref: null, changed_at: "2026-09-22", note: "Display-only until Phase 4 shows predictive value" },
    { factor: "pf", weight: 0, status: "candidate", evidence_ref: null, changed_at: "2026-09-22", note: "Display-only until Phase 4 shows predictive value" },
    { factor: "buyback_yield", weight: 0, status: "candidate", evidence_ref: null, changed_at: "2026-09-22", note: "Null outside holderValueMechanisms (DefiLlama's 0 is ambiguous)" },
    { factor: "dilution_rate", weight: 0, status: "candidate", evidence_ref: null, changed_at: "2026-09-22", note: "Momentum-ranking candidate; measured supply only" },
  ] satisfies CandidateFactor[],

  /** DefiLlama category -> bucket. Unlisted categories are "other". Note:
   * Prediction Market in perps_dex is a stretch on mechanics, justified only
   * by the thin rated universe — revisit past ~100 rated assets. */
  sectorBuckets: {
    lending: ["Lending", "CDP", "CDP Manager", "NFT Lending", "Uncollateralized Lending"],
    perps_dex: ["Dexs", "Derivatives", "DEX Aggregator", "Options", "Options Vault", "Synthetics", "Prediction Market"],
    launchpad_trading_apps: ["Launchpad", "Trading App", "Telegram Bot", "Interface"],
    liquid_staking: ["Liquid Staking", "Liquid Restaking", "Restaking", "Staking Pool"],
    yield: ["Yield", "Yield Aggregator", "Basis Trading", "Liquidity Manager", "Onchain Capital Allocator", "Risk Curators", "Leveraged Farming", "Farm"],
    oracles_infra: ["Oracle", "Bridge", "Canonical Bridge", "Cross Chain Bridge", "Developer Tools", "Services", "DePIN"],
    out_of_scope: ["Chain", "Meme"],
  } satisfies Partial<Record<SectorBucket, string[]>>,

  /** Buckets where market cap / TVL is economically meaningful. */
  mcTvlBuckets: ["lending", "liquid_staking", "yield"] satisfies SectorBucket[],

  /** Market regime. ALL thresholds are unvalidated starting guesses — revisit
   * after 28 days of stored dominance/OI history. At ~58-60% BTC dominance
   * BTC_LED will fire nearly always; if the label never varies in the first
   * month, the thresholds need revisiting — don't treat a constant label as
   * informative. Rules use three-valued logic: a rule whose deciding inputs
   * are null is not evaluable and does not fire. */
  regime: {
    validated: false,
    lookbackDays: 28, // 4-week changes; dominance & OI build from our own history
    lookbackToleranceDays: 3, // accept a stored row within ±3 days of the target date
    fundingHistoryMinDays: 30, // stored daily funding points before its percentile is used
    flatDominanceBandPts: 0.5,
    flatStablecoinBandPct: 1,
    btcLedDominanceAbovePct: 58,
    rotationDominanceDropPts: 1.5,
    frothFundingPercentile: 0.9,
    frothOiMinusPriceChangePts: 20,
    precedence: ["FROTH", "RISK_OFF", "ROTATION", "BTC_LED"],
    /** Decided 2026-09-22: stablecoin 30d change = DefiLlama's dated daily
     * chart, last complete day vs exactly 30 days earlier. Switches to our
     * own stored supply history once 30 days exist (BACKLOG, ~2026-10-22). */
    stablecoinChangeSource: "defillama /stablecoincharts/all: last complete day vs 30 days earlier",
  },

  /** Holder value-capture mechanisms, keyed by gecko_id. Absent = no known
   * mechanism → capture/buyback_yield are null (not 0). Every entry verified
   * against its sources on 2026-09-22. */
  holderValueMechanisms: {
    hyperliquid: {
      status: "active",
      mechanism: "Assistance Fund buys HYPE with ~97-99% of trading fees (97% base; 99% for some fee categories since a Dec 2025 vote); current docs say acquired HYPE is burned (a May 2026 source said only a portion)",
      sourceUrls: [
        "https://crypto.news/why-hype-is-different-inside-hyperliquids-buyback/",
        "https://crypto.news/hyperliquid-posts-strong-429m-revenue-leads-2026/",
      ],
      as_of: "2026-09-21",
    },
    "pump-fun": {
      status: "active",
      mechanism: "50% of designated revenue (launchpad, PumpSwap, trading products) buys back and burns PUMP via a locked smart contract",
      sourceUrls: ["https://coinalertnews.com/news/2026/08/31/crypto-token-buybacks-record-2026"],
      as_of: "2026-08-31",
    },
    sky: {
      status: "active",
      mechanism: "Smart Burn Engine repurchases SKY (~$26M spent in 2026)",
      sourceUrls: ["https://coinalertnews.com/news/2026/08/31/crypto-token-buybacks-record-2026"],
      as_of: "2026-08-31",
    },
    aave: {
      status: "paused",
      mechanism: "Revenue-funded AAVE buybacks paused since 2026-04-19 after the rsETH exploit on Kelp's LayerZero bridge route; Aavenomics 3.0 (automated buybacks) previewed, not live",
      sourceUrls: [
        "https://governance.aave.com/t/arfc-pause-aave-buybacks/24686",
        "https://governance.aave.com/t/restart-aave-buy-backs/24936",
      ],
      as_of: "2026-06-25",
    },
    ethena: {
      status: "conditional",
      mechanism: "Fee switch passed; ENA buybacks start only once USDe's 14-day average supply exceeds $7.5B (~$4.1B at 2026-08-30)",
      sourceUrls: [
        "https://ethdaily.io/ethena-approves-protocol-fee-switch",
        "https://cryptoticker.io/en/ethena-fee-switch-ena-buyback/",
      ],
      as_of: "2026-09-04",
    },
    "lido-dao": {
      status: "conditional",
      mechanism: "NEST: above a $40M annualized staking-revenue baseline (~$109.6K/day), half the surplus buys LDO, capped at $50K/day and $10M/yr; LDO returns to the treasury, not burned",
      sourceUrls: ["https://lido.fi/ldo-hub/reports/h1-2026"],
      as_of: "2026-06-30", // report covers Jan 1-Jun 30 2026 and carries no publication date
    },
  } satisfies Record<string, HolderValueMechanism>,
} as const;

export type ScreenerConfig = typeof SCREENER_CONFIG;

export function sectorBucketFor(category: string | null, config: ScreenerConfig = SCREENER_CONFIG): SectorBucket {
  if (!category) return "other";
  for (const [bucket, categories] of Object.entries(config.sectorBuckets) as [SectorBucket, readonly string[]][]) {
    if (categories.includes(category)) return bucket;
  }
  return "other";
}

/** Throws on a config that breaks a structural rule — called before a config
 * version is ever recorded, so an invalid config can't stamp a run. */
export function validateConfig(config: { candidateFactors: readonly CandidateFactor[] }): void {
  for (const f of config.candidateFactors) {
    if (f.status === "active" && !f.evidence_ref) {
      throw new Error(`Candidate factor "${f.factor}" is active without an evidence_ref (Phase 4 result required)`);
    }
    if (f.status !== "active" && f.weight !== 0) {
      throw new Error(`Candidate factor "${f.factor}" has weight ${f.weight} but status "${f.status}" — only active factors carry weight`);
    }
  }
}

/** Key-order-independent JSON, so the hash only changes when a value does. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function configHash(config: unknown = SCREENER_CONFIG): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}
