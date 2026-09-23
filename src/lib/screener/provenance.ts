// Lean provenance (pure — see provenance.test.ts). Replaces the old per-row
// `screener_asset_snapshots.provenance` JSONB, which repeated an identical
// {source, endpoint, fetched_at} for every field on every row (plus the
// contributing slug list 10x per live row) — 92% of a backfilled row's
// on-disk size and 70% of a live row's, measured 2026-09-22. That column was
// the direct cause of the 1.7 GB / 0.5 GB Supabase quota overage.
//
// Shape now:
//   screener_runs.provenance            one manifest per run: field -> {source, endpoint}
//   screener_asset_snapshots.provenance_override
//                                       null unless a row's field came from somewhere
//                                       other than its run's manifest
//   screener_asset_snapshots.contributing_slugs
//                                       stored once per row, fills `{slug}` templates
//
// Principle #3 ("every field carries provenance: source, endpoint, fetch
// timestamp") still holds — it's resolved (resolveFieldProvenance), not
// repeated.

export interface FieldSource {
  source: string;
  /** May contain `{slug}` (expanded once per contributing slug) or
   * `{gecko_id}` placeholders — see resolveFieldProvenance. */
  endpoint: string;
}

export interface RunProvenance {
  fetched_at: string;
  fields: Record<string, FieldSource>;
}

export type ProvenanceOverride = Record<string, FieldSource> | null;

const COINGECKO_MARKETS: FieldSource = { source: "coingecko", endpoint: "/coins/markets" };
const liveFees = (dataType: string): FieldSource => ({
  source: "defillama",
  endpoint: `/overview/fees?dataType=${dataType}`,
});

/** A degraded live run (CoinGecko unavailable): price from DefiLlama's
 * coins API, and the CoinGecko-only fields recorded as not fetched — they
 * are null on every row of that run, and the manifest must say why rather
 * than claim a source that wasn't called. */
const DEFILLAMA_PRICES_CURRENT: FieldSource = { source: "defillama", endpoint: "coins.llama.fi /prices/current/coingecko:{gecko_id}" };
const NOT_FETCHED_COINGECKO_DOWN: FieldSource = {
  source: "none (not fetched: CoinGecko unavailable this run; degraded run)",
  endpoint: "/coins/markets",
};

export function buildLiveRunProvenance(fetchedAt: string, opts: { degraded?: boolean } = {}): RunProvenance {
  const cg = opts.degraded ? NOT_FETCHED_COINGECKO_DOWN : COINGECKO_MARKETS;
  return {
    fetched_at: fetchedAt,
    fields: {
      price_usd: opts.degraded ? DEFILLAMA_PRICES_CURRENT : COINGECKO_MARKETS,
      market_cap_usd: cg,
      fdv_usd: cg,
      circulating_supply: cg,
      total_supply: cg,
      max_supply: cg,
      volume_24h_usd: cg,
      tvl_usd: { source: "defillama", endpoint: "/protocols" },
      fees_24h: liveFees("dailyFees"),
      fees_7d: liveFees("dailyFees"),
      fees_30d: liveFees("dailyFees"),
      fees_1y: liveFees("dailyFees"),
      revenue_24h: liveFees("dailyRevenue"),
      revenue_7d: liveFees("dailyRevenue"),
      revenue_30d: liveFees("dailyRevenue"),
      revenue_1y: liveFees("dailyRevenue"),
      holders_revenue_24h: liveFees("dailyHoldersRevenue"),
      holders_revenue_30d: liveFees("dailyHoldersRevenue"),
    },
  };
}

const COINGECKO_MARKET_CHART: FieldSource = { source: "coingecko", endpoint: "/coins/{gecko_id}/market_chart" };
const historyDaily = (dataType: string): FieldSource => ({
  source: "defillama (daily values summed across contributing slugs)",
  endpoint: `/summary/fees/{slug}?dataType=${dataType}`,
});
const historyRolling = (dataType: string): FieldSource => ({
  source: "defillama (rolling 30d sum of daily values summed across contributing slugs, computed here)",
  endpoint: `/summary/fees/{slug}?dataType=${dataType}`,
});

/** Backfill manifest. price_usd defaults to DefiLlama; a date DefiLlama
 * didn't cover falls back to CoinGecko and carries
 * BACKFILL_PRICE_FALLBACK_OVERRIDE on that row only. */
export function buildBackfillRunProvenance(fetchedAt: string): RunProvenance {
  return {
    fetched_at: fetchedAt,
    fields: {
      price_usd: { source: "defillama", endpoint: "/chart/coingecko:{gecko_id}" },
      market_cap_usd: COINGECKO_MARKET_CHART,
      volume_24h_usd: COINGECKO_MARKET_CHART,
      fees_24h: historyDaily("dailyFees"),
      fees_30d: historyRolling("dailyFees"),
      revenue_24h: historyDaily("dailyRevenue"),
      revenue_30d: historyRolling("dailyRevenue"),
      holders_revenue_24h: historyDaily("dailyHoldersRevenue"),
      holders_revenue_30d: historyRolling("dailyHoldersRevenue"),
    },
  };
}

export const BACKFILL_PRICE_FALLBACK_OVERRIDE: ProvenanceOverride = { price_usd: COINGECKO_MARKET_CHART };

export interface ResolvedFieldProvenance {
  source: string;
  endpoints: string[];
  fetched_at: string;
}

/** A field's full provenance: the row's override if it has one for this
 * field, else the run manifest's entry, with `{slug}`/`{gecko_id}`
 * templates expanded. null only when neither declares the field — which
 * means the field was never written by that run (e.g. fdv_usd on a
 * backfilled row), not "unknown source". */
export function resolveFieldProvenance(
  field: string,
  run: RunProvenance,
  override: ProvenanceOverride,
  ctx: { geckoId: string; contributingSlugs: readonly string[] },
): ResolvedFieldProvenance | null {
  const entry = override?.[field] ?? run.fields[field];
  if (!entry) return null;
  const withId = entry.endpoint.replaceAll("{gecko_id}", ctx.geckoId);
  const endpoints = withId.includes("{slug}") ? ctx.contributingSlugs.map((s) => withId.replaceAll("{slug}", s)) : [withId];
  return { source: entry.source, endpoints, fetched_at: run.fetched_at };
}
