// Pure plausibility check for a run's derived metrics — see
// plausibility.test.ts and config.plausibility. Why it exists: the first
// Phase 2b run computed a median beta-to-BTC of 0.07 for the rated set. No
// check failed; every row was "valid". The cause was two readings labelled
// "daily" that were ~21.5h apart, and it was only caught because 0.07 is
// implausible on domain grounds. A silent wrong number is worse than a loud
// failure, so implausible run-level results are now reported, not eyeballed.

import { SCREENER_CONFIG, type ScreenerConfig } from "./config.ts";

type Row = { rated: boolean };

export interface PlausibilityWarning {
  metric: string;
  kind: "median" | "per_asset";
  value: number; // the median, or the count of out-of-range assets
  range: { min: number; max: number };
  n: number; // rated assets with a non-null value
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function checkPlausibility(rows: readonly Row[], config: ScreenerConfig = SCREENER_CONFIG): PlausibilityWarning[] {
  const rated = rows.filter((r) => r.rated);
  const valuesOf = (metric: string) =>
    rated.map((r) => (r as Record<string, unknown>)[metric]).filter((v): v is number => typeof v === "number");
  const warnings: PlausibilityWarning[] = [];

  for (const [metric, range] of Object.entries(config.plausibility.median)) {
    const values = valuesOf(metric);
    const m = median(values);
    if (m !== null && (m < range.min || m > range.max)) warnings.push({ metric, kind: "median", value: m, range, n: values.length });
  }
  for (const [metric, range] of Object.entries(config.plausibility.perAsset)) {
    const values = valuesOf(metric);
    const outside = values.filter((v) => v < range.min || v > range.max).length;
    if (outside > 0) warnings.push({ metric, kind: "per_asset", value: outside, range, n: values.length });
  }
  return warnings;
}
