// Performance's chart data, packed for the browser (2026-09-29: 52 wallet
// series × 381 days as {date, total, kind} objects were 1.2 MB a view —
// every date string repeated per wallet, every total to 16 decimals).
// The dates are sent once; each series is its totals aligned to them (null
// where it has no point) and a kind letter per date. Pure.

import type { StitchedPoint } from "./performance.ts";

export interface PackedSeries {
  totals: (number | null)[];
  /** One letter per date: "e" estimated, "r" real, "-" no point. */
  kinds: string;
}

/** A total rounded for the chart: to the cent, or 4 significant digits
 * under $1 (a dust wallet's line keeps its shape). */
export function roundTotal(total: number): number {
  return Math.abs(total) >= 1 ? Math.round(total * 100) / 100 : Number(total.toPrecision(4));
}

export function packSeries(series: readonly (readonly StitchedPoint[])[]): { dates: string[]; packed: PackedSeries[] } {
  const dates = [...new Set(series.flatMap((s) => s.map((p) => p.date)))].sort();
  const index = new Map(dates.map((d, i) => [d, i]));
  const packed = series.map((s) => {
    const totals: (number | null)[] = dates.map(() => null);
    const kinds = dates.map(() => "-");
    for (const p of s) {
      const i = index.get(p.date)!;
      totals[i] = roundTotal(p.total);
      kinds[i] = p.kind === "real" ? "r" : "e";
    }
    return { totals, kinds: kinds.join("") };
  });
  return { dates, packed };
}

export function unpackSeries(dates: readonly string[], packed: PackedSeries): StitchedPoint[] {
  const out: StitchedPoint[] = [];
  for (let i = 0; i < dates.length; i++) {
    const k = packed.kinds[i];
    if (k === "-" || packed.totals[i] === null) continue;
    out.push({ date: dates[i], total: packed.totals[i]!, kind: k === "r" ? "real" : "estimated" });
  }
  return out;
}

export const hasPoints = (packed: PackedSeries) => /[er]/.test(packed.kinds);
