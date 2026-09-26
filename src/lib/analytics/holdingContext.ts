// Where each holding stands — the context for a buy/sell decision, not a
// recommendation. Pure. Each figure comes from stored data (asset_prices,
// daily price history, the risk profile); a figure the data can't give is
// null and shows as "—". Flags are plain observations with fixed thresholds.

import { daysBefore } from "./attribution.ts";
import type { AssetRisk, DailyPrices } from "./risk.ts";

export const RANGE_DAYS = 90;
/** Fewer daily prices than this in the range window and there's no range. */
const MIN_RANGE_POINTS = 20;

export const FLAG_THRESHOLDS = {
  /** Share of the whole portfolio. */
  largePosition: 0.2,
  /** Risk share at least this multiple of the asset's weight … */
  riskHeavyRatio: 1.5,
  /** … and at least this share of the portfolio's risk. */
  riskHeavyMin: 0.05,
  nearEdge: 0.05,
  deepDrawdown: -0.5,
  ranUpPct: 50,
  /** Position as a share of the asset's 24h trading volume. */
  thinMarket: 0.01,
  smallCapUsd: 50_000_000,
} as const;

export type FlagId = "large" | "riskHeavy" | "nearHigh" | "nearLow" | "deepDrawdown" | "ranUp" | "thinMarket" | "smallCap";

export interface Flag {
  id: FlagId;
  label: string;
  detail: string;
}

export interface HoldingContextInput {
  key: string;
  ticker: string;
  iconUrl: string | null;
  valueUsd: number;
  price: number | null;
  change7d: number | null;
  change30d: number | null;
  marketCap: number | null;
  volume24h: number | null;
  prices: DailyPrices | undefined;
  risk: AssetRisk | null;
}

export interface HoldingContext {
  key: string;
  ticker: string;
  iconUrl: string | null;
  valueUsd: number;
  /** Share of the whole portfolio's value. */
  weight: number;
  change7d: number | null;
  change30d: number | null;
  /** Current price vs the highest daily price in the range window (≤ 0). */
  fromHigh: number | null;
  /** Where the current price sits between the window's low (0) and high (1). */
  rangePosition: number | null;
  volatility: number | null;
  beta: number | null;
  riskShare: number | null;
  /** Position value ÷ 24h trading volume. */
  volumeShare: number | null;
  marketCap: number | null;
  cashLike: boolean;
  flags: Flag[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function holdingContext(a: HoldingContextInput, totalUsd: number, today: string): HoldingContext {
  const weight = totalUsd > 0 ? a.valueUsd / totalUsd : 0;
  const since = daysBefore(today, RANGE_DAYS);
  const window = a.prices ? [...a.prices].filter(([d]) => d >= since).map(([, p]) => p) : [];
  if (a.price !== null) window.push(a.price);
  const hasRange = a.price !== null && window.length >= MIN_RANGE_POINTS;
  const high = hasRange ? Math.max(...window) : null;
  const low = hasRange ? Math.min(...window) : null;
  const fromHigh = high !== null && high > 0 ? a.price! / high - 1 : null;
  const rangePosition = high !== null && low !== null && high > low ? (a.price! - low) / (high - low) : null;
  const volumeShare = a.volume24h !== null && a.volume24h > 0 ? a.valueUsd / a.volume24h : null;
  const cashLike = a.risk?.cashLike ?? false;

  const T = FLAG_THRESHOLDS;
  const flags: Flag[] = [];
  if (weight >= T.largePosition) flags.push({ id: "large", label: "Large position", detail: `${pct(weight)} of your portfolio` });
  if (!cashLike) {
    const r = a.risk;
    if (r && r.riskShare >= T.riskHeavyMin && r.riskShare >= T.riskHeavyRatio * r.weight)
      flags.push({ id: "riskHeavy", label: "Outsized risk", detail: `${pct(r.riskShare)} of your portfolio's swings from ${pct(r.weight)} of its value` });
    if (rangePosition !== null && rangePosition >= 1 - T.nearEdge) flags.push({ id: "nearHigh", label: "Near 90-day high", detail: "Trading at the top of its 90-day range" });
    if (rangePosition !== null && rangePosition <= T.nearEdge) flags.push({ id: "nearLow", label: "Near 90-day low", detail: "Trading at the bottom of its 90-day range" });
    if (fromHigh !== null && fromHigh <= T.deepDrawdown) flags.push({ id: "deepDrawdown", label: "Deep drawdown", detail: `${pct(-fromHigh)} below its 90-day high` });
    if (a.change30d !== null && a.change30d >= T.ranUpPct) flags.push({ id: "ranUp", label: "Ran up", detail: `Up ${Math.round(a.change30d)}% in 30 days` });
    if (volumeShare !== null && volumeShare >= T.thinMarket)
      flags.push({ id: "thinMarket", label: "Thin market", detail: `Your position is ${(volumeShare * 100).toFixed(1)}% of a day's trading volume — selling it could move the price` });
    if (a.marketCap !== null && a.marketCap > 0 && a.marketCap < T.smallCapUsd) flags.push({ id: "smallCap", label: "Small cap", detail: "Market cap under $50M" });
  }

  return {
    key: a.key,
    ticker: a.ticker,
    iconUrl: a.iconUrl,
    valueUsd: a.valueUsd,
    weight,
    change7d: a.change7d,
    change30d: a.change30d,
    fromHigh,
    rangePosition,
    volatility: a.risk?.volatility ?? null,
    beta: a.risk?.beta ?? null,
    riskShare: a.risk?.riskShare ?? null,
    volumeShare,
    marketCap: a.marketCap,
    cashLike,
    flags,
  };
}
