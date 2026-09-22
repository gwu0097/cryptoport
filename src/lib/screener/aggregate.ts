// Pure fee/revenue aggregation shared by the live snapshot job AND the
// backfill — no DB/network, so it's directly unit-testable (aggregate.test.ts).
//
// Why this is one module and not two copies: the backfill used to fetch
// history for a single slug per asset (`screener_assets.defillama_slug`,
// just the group's FIRST child) while the live job summed every child
// protocol. Grouped assets came out badly wrong in the backfill —
// live-verified 2026-09-22: Hyperliquid backfilled revenue_30d was null
// (only `hyperliquid-spot-orderbook` was fetched) vs. $60.6M live; Uniswap
// fees_30d $56M (v3 only) vs. $195M live; GMX revenue $0.52M vs. $1.34M.
// Group membership (resolveGroups) and the per-metric summation
// (sumAcrossSlugs) now live here, and both paths go through them.

/** Structural subset of adapters/defillama.ts's DefiLlamaProtocol — kept
 * local so this file stays importable under `node --test` without pulling
 * the server-only adapter. */
export interface ProtocolForGrouping {
  slug: string;
  geckoId: string | null;
  category: string | null;
  tvl: number | null;
  mcap: number | null;
  parentProtocol: string | null;
}

export interface ParentForGrouping {
  geckoId: string | null;
  mcap: number | null;
}

/** Structural subset of adapters/defillama.ts's ProtocolFeeTotals. */
export interface FeeTotals {
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  total1y: number | null;
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD, UTC
  value: number;
}

/** Sums the non-null values; null only if every input was null — a group
 * with SOME children reporting a metric still gets a real (partial) sum,
 * but a group where nothing at all is known stays null rather than
 * becoming a fabricated 0 (build-prompt principle #2). */
export function sumOrNull(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0);
}

/** THE aggregation rule, used by both paths: an asset's value for a metric
 * is the sumOrNull of that metric across every contributing slug. The
 * live job looks up each slug's rolling total; the backfill looks up each
 * slug's value for one date — same membership, same summation. */
export function sumAcrossSlugs(slugs: readonly string[], valueFor: (slug: string) => number | null | undefined): number | null {
  return sumOrNull(slugs.map(valueFor));
}

export interface GroupMembership {
  geckoId: string;
  /** Every DefiLlama protocol slug whose data sums into this asset, in
   * DefiLlama's own /protocols order. Stored per snapshot row
   * (`contributing_slugs`) so the backfill can reuse the live job's exact
   * membership instead of re-deriving it. */
  contributingSlugs: string[];
  category: string | null;
  /** DefiLlama's own mcap for the conflict check — the parent's aggregate
   * figure when parent-resolved (summing children's own mcap would
   * double-count overlapping supply across versions), else the single
   * protocol's own mcap. First writer wins, never summed. */
  mcapForConflictCheck: number | null;
  tvl: number | null;
}

/**
 * Resolves each fee-bearing DefiLlama protocol to the gecko_id it should be
 * valued under and groups by that id. DefiLlama splits major protocols into
 * versioned/product-line children (Uniswap V1-V4, GMX V1/V2, Hyperliquid
 * Spot/HLP/Perps) that carry NO gecko_id of their own — it lives only on
 * the parent aggregate (/lite/protocols2). A protocol resolves via its own
 * gecko_id when it has one (Aave's "aave-v2" does); only falls back to its
 * parent's when its own is null. Without this, Uniswap, Hyperliquid and GMX
 * were entirely absent from the universe (Phase 1, live-verified).
 */
export function resolveGroups(
  candidates: readonly ProtocolForGrouping[],
  parents: ReadonlyMap<string, ParentForGrouping>,
): { groups: Map<string, GroupMembership>; unresolved: ProtocolForGrouping[] } {
  const groups = new Map<string, GroupMembership>();
  const unresolved: ProtocolForGrouping[] = [];

  for (const protocol of candidates) {
    let geckoId = protocol.geckoId;
    let mcapSource = protocol.mcap;
    if (!geckoId && protocol.parentProtocol) {
      const parent = parents.get(protocol.parentProtocol);
      if (parent?.geckoId) {
        geckoId = parent.geckoId;
        mcapSource = parent.mcap;
      }
    }
    if (!geckoId) {
      unresolved.push(protocol);
      continue;
    }

    const existing = groups.get(geckoId);
    if (!existing) {
      groups.set(geckoId, {
        geckoId,
        contributingSlugs: [protocol.slug],
        category: protocol.category,
        mcapForConflictCheck: mcapSource,
        tvl: protocol.tvl,
      });
    } else {
      existing.contributingSlugs.push(protocol.slug);
      existing.category ??= protocol.category;
      existing.tvl = sumOrNull([existing.tvl, protocol.tvl]);
    }
  }

  return { groups, unresolved };
}

export interface GroupTotals {
  fees24h: number | null;
  fees7d: number | null;
  fees30d: number | null;
  fees1y: number | null;
  revenue24h: number | null;
  revenue7d: number | null;
  revenue30d: number | null;
  revenue1y: number | null;
  holdersRevenue24h: number | null;
  holdersRevenue30d: number | null;
}

/** Live path: DefiLlama's own rolling totals (/overview/fees), summed
 * across the group's slugs. */
export function aggregateGroupTotals(
  slugs: readonly string[],
  fees: ReadonlyMap<string, FeeTotals>,
  revenue: ReadonlyMap<string, FeeTotals>,
  holdersRevenue: ReadonlyMap<string, FeeTotals>,
): GroupTotals {
  return {
    fees24h: sumAcrossSlugs(slugs, (s) => fees.get(s)?.total24h),
    fees7d: sumAcrossSlugs(slugs, (s) => fees.get(s)?.total7d),
    fees30d: sumAcrossSlugs(slugs, (s) => fees.get(s)?.total30d),
    fees1y: sumAcrossSlugs(slugs, (s) => fees.get(s)?.total1y),
    revenue24h: sumAcrossSlugs(slugs, (s) => revenue.get(s)?.total24h),
    revenue7d: sumAcrossSlugs(slugs, (s) => revenue.get(s)?.total7d),
    revenue30d: sumAcrossSlugs(slugs, (s) => revenue.get(s)?.total30d),
    revenue1y: sumAcrossSlugs(slugs, (s) => revenue.get(s)?.total1y),
    holdersRevenue24h: sumAcrossSlugs(slugs, (s) => holdersRevenue.get(s)?.total24h),
    holdersRevenue30d: sumAcrossSlugs(slugs, (s) => holdersRevenue.get(s)?.total30d),
  };
}

/** Backfill path: each slug's DAILY history (/summary/fees/{slug}), summed
 * per date across the group's slugs — the same sumAcrossSlugs rule the
 * live path uses, applied one date at a time. A date where no slug has a
 * value is simply absent (never a 0). */
export function sumDailySeriesAcrossSlugs(
  slugs: readonly string[],
  seriesBySlug: ReadonlyMap<string, readonly DailyPoint[]>,
): DailyPoint[] {
  const bySlugDate = new Map<string, Map<string, number>>();
  const dates = new Set<string>();
  for (const slug of slugs) {
    const m = new Map<string, number>();
    for (const p of seriesBySlug.get(slug) ?? []) {
      m.set(p.date, p.value);
      dates.add(p.date);
    }
    bySlugDate.set(slug, m);
  }
  const result: DailyPoint[] = [];
  for (const date of [...dates].sort()) {
    const value = sumAcrossSlugs(slugs, (s) => bySlugDate.get(s)?.get(date));
    if (value !== null) result.push({ date, value });
  }
  return result;
}

/**
 * DefiLlama's per-protocol history reports one DAILY value per day, not a
 * rolling window (live-verified against Aave: trailing 30 daily points
 * summed to within ~0.5% of the live total30d). The live job's `_30d`
 * columns store DefiLlama's rolling total30d, so backfilled rows need the
 * same rolling sum computed here — copying the daily value into a
 * `_30d`-named column would be off by ~30x.
 */
export function rollingSum(series: readonly DailyPoint[], windowDays: number): Map<string, number> {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const result = new Map<string, number>();
  let windowStart = 0;
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i].value;
    const cutoff = new Date(sorted[i].date);
    cutoff.setUTCDate(cutoff.getUTCDate() - windowDays + 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    while (windowStart < i && sorted[windowStart].date < cutoffStr) {
      sum -= sorted[windowStart].value;
      windowStart++;
    }
    result.set(sorted[i].date, sum);
  }
  return result;
}
