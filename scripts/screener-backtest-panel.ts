// Phase 4a: the point-in-time panel for one window — 1y (primary; backfilled
// rows from Supabase, production "rated" population, plus the survivorship
// bound) or 2y / 3y (momentum robustness; the deep Parquet store from
// scripts/screener-deep-history.ts, the labeled "deep" population). Read-only against Supabase and DefiLlama (one
// /overview/fees call); ZERO CoinGecko calls. Writes to
// ~/cryptoport-archive/screener/backtest/ (SCREENER_ARCHIVE_DIR/backtest):
//   panel_<w>.parquet / panel_<w>.csv   one row per (formation date, asset in that day's universe)
//   coverage_<w>.json                   per-date counts (+ the survivorship bound for 1y)
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/screener-backtest-panel.ts [--window 1y|2y|3y]
//
// Scoring goes through the production path (backtest.ts -> computeAssetMetrics
// / computeHistoryMetrics / scoreRun); BTC pairing through loadBtcReference
// over a full year. Definitions: docs/screener/PHASE_4_PLAN.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.loadEnvFile(`${__dirname}/../.env.local`);

const BACKFILL_LAST_DATE = "2026-09-21"; // the backfill's last complete day
const MIN_RATED_WITH_BOTH_LEGS = 30;
const DEEP_RUN = "deep-00:00"; // synthetic run id for the deep store's single 00:00 grid

async function main() {
  const { serviceDb } = await import("../src/lib/supabase");
  const { loadBtcReference } = await import("../src/lib/screener/derive");
  const { buildPeriod, HORIZONS } = await import("../src/lib/screener/backtest");
  const { shiftDate } = await import("../src/lib/screener/history");
  const { fetchAllRows } = await import("../src/lib/screener/pagination");
  const { writeParquetVerified } = await import("../src/lib/screener/archive");
  const { fetchFeesOverview } = await import("../src/lib/screener/adapters/defillama");
  type PanelAsset = import("../src/lib/screener/backtest").PanelAsset;
  type PanelReading = import("../src/lib/screener/backtest").PanelReading;
  type PanelRow = import("../src/lib/screener/backtest").PanelRow;

  const dir = join(process.env.SCREENER_ARCHIVE_DIR ?? join(homedir(), "cryptoport-archive", "screener"), "backtest");
  mkdirSync(dir, { recursive: true });
  const db = serviceDb();
  const t0 = Date.now();

  const wAt = process.argv.indexOf("--window");
  const window = wAt === -1 ? "1y" : process.argv[wAt + 1];
  if (!["1y", "2y", "3y"].includes(window)) throw new Error(`--window must be 1y, 2y or 3y (got ${window})`);
  const rule: "rated" | "deep" = window === "1y" ? "rated" : "deep";

  const { data: assetRows, error: assetError } = await db.from("screener_assets").select("id, gecko_id, sector");
  if (assetError) throw new Error(assetError.message);
  let assets: PanelAsset[];
  let btc: import("../src/lib/screener/history").BtcReference;
  let LAST_DATA_DATE: string;
  let earliestFormation: string | null = null;
  let deepManifest: Record<string, unknown> | null = null;

  if (window === "1y") {
    LAST_DATA_DATE = BACKFILL_LAST_DATE;
    type Row = PanelReading & { id: string; asset_id: string; provenance_override: { price_usd?: { source?: string } } | null };
    const rows = await fetchAllRows<Row>(async (cursor, limit) =>
      db
        .from("screener_asset_snapshots")
        .select("id, asset_id, observed_at, is_backfilled, run_id, price_usd, market_cap_usd, circulating_supply, revenue_30d, volume_24h_usd, fees_30d, holders_revenue_30d, provenance_override")
        .eq("is_backfilled", true)
        .gt("id", cursor)
        .order("id")
        .limit(limit) as never,
    );
    console.log(`loaded ${rows.length} backfilled rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    // Same-moment price for implied supply (market cap ÷ price). The stored
    // market cap is CoinGecko's 00:00 point; a DefiLlama-priced row's price is
    // from the backfill run's ~21:31 grid (verified 2026-09-23). So take the
    // verified deep store's 00:00 price for that date, or null — never the
    // mixed-moment stored price. A CoinGecko-priced row's own price is
    // already the 00:00 point (verified), so it is its own same-moment price.
    const { parquetReadObjects, asyncBufferFromFile } = await import("hyparquet/src/node.js");
    const deep00 = new Map<string, number>();
    for (const p of (await parquetReadObjects({ file: await asyncBufferFromFile(join(dir, "..", "deep", "deep_prices.parquet")) })) as {
      gecko_id: string;
      date: string;
      price_usd: number;
    }[])
      deep00.set(`${p.gecko_id}|${p.date}`, p.price_usd);
    const geckoOf = new Map((assetRows ?? []).map((a) => [a.id as string, a.gecko_id as string]));
    const byAsset = new Map<string, PanelReading[]>();
    const backfillRunIds = new Set<string>();
    for (const r of rows) {
      r.price_from_coingecko = r.provenance_override?.price_usd?.source === "coingecko";
      r.price_at_mcap_moment = r.price_from_coingecko ? r.price_usd : (deep00.get(`${geckoOf.get(r.asset_id)}|${r.observed_at.slice(0, 10)}`) ?? null);
      backfillRunIds.add(r.run_id);
      if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
      byAsset.get(r.asset_id)!.push(r);
    }
    assets = (assetRows ?? [])
      .filter((a) => byAsset.has(a.id as string))
      .map((a) => ({ asset_id: a.id as string, gecko_id: a.gecko_id as string, sector: a.sector as string | null, readings: byAsset.get(a.id as string)! }));
    // BTC for every backfill run's grid and midnight, over the whole year.
    const ref = await loadBtcReference(`${shiftDate(LAST_DATA_DATE, 1)}T00:00:00Z`, new Map(), backfillRunIds, 370);
    btc = ref.btc;
    console.log(`BTC reference: ${ref.grids} grids`);
  } else {
    // The deep store: one 00:00 grid for every coin, BTC included — so BTC
    // pairs from the same grid (a synthetic run id), no network needed here.
    const { parquetReadObjects, asyncBufferFromFile } = await import("hyparquet/src/node.js");
    const deepDir = join(dir, "..", "deep");
    deepManifest = JSON.parse(readFileSync(join(deepDir, "manifest.json"), "utf8"));
    const prices = (await parquetReadObjects({ file: await asyncBufferFromFile(join(deepDir, "deep_prices.parquet")) })) as { gecko_id: string; date: string; price_usd: number }[];
    const revenue = (await parquetReadObjects({ file: await asyncBufferFromFile(join(deepDir, "deep_revenue.parquet")) })) as { gecko_id: string; date: string; revenue_usd: number }[];
    const revByGecko = new Map<string, Map<string, number>>();
    for (const r of revenue) {
      if (!revByGecko.has(r.gecko_id)) revByGecko.set(r.gecko_id, new Map());
      revByGecko.get(r.gecko_id)!.set(r.date, r.revenue_usd);
    }
    // Trailing 30-day revenue ending on `date`: complete days only (flows
    // rule) — all 30 days present, else null (never a partial sum).
    const trailing30 = (g: string, date: string): number | null => {
      const m = revByGecko.get(g);
      if (!m) return null;
      let sum = 0;
      for (let k = 0; k < 30; k++) {
        const v = m.get(shiftDate(date, -k));
        if (v === undefined) return null;
        sum += v;
      }
      return sum;
    };
    const pricesByGecko = new Map<string, { date: string; price_usd: number }[]>();
    for (const p of prices) {
      if (!pricesByGecko.has(p.gecko_id)) pricesByGecko.set(p.gecko_id, []);
      pricesByGecko.get(p.gecko_id)!.push(p);
    }
    const btcGrid = new Map((pricesByGecko.get("bitcoin") ?? []).map((p) => [p.date, p.price_usd] as [string, number]));
    btc = { backfillGridByRun: new Map([[DEEP_RUN, btcGrid]]), midnight: new Map(), byRun: new Map() };
    assets = (assetRows ?? [])
      .filter((a) => pricesByGecko.has(a.gecko_id as string))
      .map((a) => ({
        asset_id: a.id as string,
        gecko_id: a.gecko_id as string,
        sector: a.sector as string | null,
        readings: pricesByGecko.get(a.gecko_id as string)!.map((p) => ({
          observed_at: `${p.date}T00:00:00.000Z`,
          is_backfilled: true,
          run_id: DEEP_RUN,
          price_usd: p.price_usd,
          market_cap_usd: null,
          circulating_supply: null,
          revenue_30d: trailing30(a.gecko_id as string, p.date),
          volume_24h_usd: null,
          fees_30d: null,
          holders_revenue_30d: null,
        })),
      }));
    const lastDeep = [...btcGrid.keys()].sort().at(-1)!;
    LAST_DATA_DATE = lastDeep;
    earliestFormation = shiftDate(lastDeep, window === "2y" ? -730 : -1095);
    console.log(`deep store: ${prices.length} price rows, ${assets.length} assets, BTC ${btcGrid.size} days, last ${lastDeep}; formation dates from ${earliestFormation}`);
  }

  // Formation dates (definitions): walk back 30 days at a time from
  // LAST_DATA_DATE − 30 until a date has fewer than 30 rated assets with both legs.
  const panel: PanelRow[] = [];
  const coverage: Record<string, unknown>[] = [];
  const periods = new Map<string, PanelRow[]>();
  for (let d = shiftDate(LAST_DATA_DATE, -30); ; d = shiftDate(d, -30)) {
    if (earliestFormation && d < earliestFormation) {
      console.log(`${d}: before the ${window} window's start (${earliestFormation}) — stop`);
      break;
    }
    const period = buildPeriod(d, assets, btc, undefined, rule);
    const rated = period.filter((r) => r.rated);
    const bothLegs = rated.filter((r) => r.mom_3w !== null && r.mom_12w !== null).length;
    if (bothLegs < MIN_RATED_WITH_BOTH_LEGS) {
      console.log(`${d}: ${bothLegs} rated with both legs < ${MIN_RATED_WITH_BOTH_LEGS} — stop (not included)`);
      break;
    }
    periods.set(d, period);
    console.log(`${d}: universe ${period.length}, rated ${rated.length}, both legs ${bothLegs}`);
  }
  const dates30 = [...periods.keys()].sort();
  // 90-day set: D_last = LAST_DATA_DATE − 90, step 90 — a subset of the 30-day dates here.
  const dates90: string[] = [];
  for (let d = shiftDate(LAST_DATA_DATE, -90); periods.has(d); d = shiftDate(d, -90)) dates90.unshift(d);
  for (const d of dates30) {
    const period = periods.get(d)!;
    const rated = period.filter((r) => r.rated);
    panel.push(...period);
    coverage.push({
      date: d,
      in_30d_set: true,
      in_90d_set: dates90.includes(d),
      universe: period.length,
      rated: rated.length,
      rated_both_legs: rated.filter((r) => r.mom_3w !== null && r.mom_12w !== null).length,
      rated_with_fwd30: rated.filter((r) => r.fwd30_btc !== null).length,
      rated_with_fwd90: rated.filter((r) => r.fwd90_btc !== null).length,
      rated_coingecko_priced_at_d: rated.filter((r) => r.price_from_coingecko).length,
      tags: Object.fromEntries(["LEADER", "NEUTRAL", "WATCH", "SPECULATIVE", "AVOID"].map((t) => [t, rated.filter((r) => r.setup_tag === t).length])),
      high_risk: rated.filter((r) => r.quality_risk_tier === "high_risk").length,
    });
  }

  // Survivorship bound (decision 1): protocols DefiLlama still lists whose
  // trailing-year revenue is >= $1M (so their annualized 30-day revenue
  // cleared the floor at some point) but that have no CoinGecko-matched
  // asset today. Split by why they're unmatched: a resolved token CoinGecko
  // has no market data for (delisted/dead — the survivorship case) vs no
  // token at all (not survivorship: nothing to hold). Protocols DefiLlama
  // dropped from its list entirely are invisible here — it's a lower bound.
  let survivorship: Record<string, unknown> = { see: "coverage_1y.json (the bound is computed once, on the 1y window)" };
  if (window === "1y") {
  const revenue = await fetchFeesOverview("dailyRevenue");
  const open = await fetchAllRows<{ id: string; kind: string; identifier: string; reason: string | null }>(async (cursor, limit) =>
    db.from("screener_unmatched").select("id, kind, identifier, reason").is("resolved_run_id", null).gt("id", cursor).order("id").limit(limit) as never,
  );
  const total1y = (slug: string) => revenue.get(slug)?.total1y ?? null;
  const deadTokens = open
    .filter((u) => u.kind === "no_coingecko_market_data")
    .map((u) => {
      const slugs = (u.reason?.match(/slug\(s\): ([^)]*)\)/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const vals = slugs.map(total1y).filter((v): v is number => v !== null);
      return { gecko_id: u.identifier, slugs, revenue_1y: vals.length ? vals.reduce((a, b) => a + b, 0) : null };
    })
    .filter((x) => x.revenue_1y !== null && x.revenue_1y >= 1_000_000)
    .sort((a, b) => b.revenue_1y! - a.revenue_1y!);
  const noToken = open.filter((u) => u.kind === "no_gecko_id").filter((u) => (total1y(u.identifier) ?? 0) >= 1_000_000);
  survivorship = {
    definition:
      "Protocols still listed by DefiLlama with trailing-1y revenue >= $1M and no CoinGecko-matched asset today. Lower bound: protocols DefiLlama dropped entirely are invisible.",
    resolved_token_without_coingecko_data: deadTokens.length,
    resolved_token_without_coingecko_data_top: deadTokens.slice(0, 15),
    no_token_at_all_not_survivorship: noToken.length,
  };
  }

  const columns = [
    ["date", "STRING"], ["asset_id", "STRING"], ["gecko_id", "STRING"], ["rated", "BOOLEAN"], ["gates_failed", "STRING"],
    ["sector_bucket", "STRING"], ["size_log_mcap", "DOUBLE"], ["mom_3w", "DOUBLE"], ["mom_12w", "DOUBLE"], ["beta_btc", "DOUBLE"],
    ["ps_circ", "DOUBLE"], ["pf_circ", "DOUBLE"], ["dilution_rate_implied", "DOUBLE"], ["timing_score", "DOUBLE"],
    ["timing_percentile", "DOUBLE"], ["setup_tag", "STRING"], ["quality_risk_tier", "STRING"], ["price_d", "DOUBLE"], ["btc_d", "DOUBLE"],
    ["price_d30", "DOUBLE"], ["btc_d30", "DOUBLE"], ["price_d90", "DOUBLE"], ["btc_d90", "DOUBLE"], ["fwd30_btc", "DOUBLE"],
    ["fwd90_btc", "DOUBLE"], ["fwd30_ew", "DOUBLE"], ["fwd90_ew", "DOUBLE"], ["price_from_coingecko", "BOOLEAN"],
  ].map(([name, type]) => ({ name, type: type as "STRING" | "DOUBLE" | "BOOLEAN" }));
  const withSets = panel.map((r) => ({ ...r, in_90d_set: dates90.includes(r.date) }));
  const sha = await writeParquetVerified(join(dir, `panel_${window}.parquet`), withSets as never, [...columns, { name: "in_90d_set", type: "BOOLEAN" }]);
  const csvCols = [...columns.map((c) => c.name), "in_90d_set"];
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  writeFileSync(join(dir, `panel_${window}.csv`), [csvCols.join(","), ...withSets.map((r) => csvCols.map((c) => cell((r as Record<string, unknown>)[c])).join(","))].join("\n") + "\n");
  const out = {
    written_at: new Date().toISOString(),
    window,
    population_rule: rule,
    last_data_date: LAST_DATA_DATE,
    deep_store: deepManifest,
    horizons: HORIZONS,
    formation_dates_30d: dates30,
    formation_dates_90d: dates90,
    rows: panel.length,
    panel_content_sha256: sha,
    per_date: coverage,
    survivorship,
    notes: [
      window === "1y"
        ? "All periods are backfilled (live history: 2 days). No regime history for past dates; modifiers are 0."
        : "Deep window: momentum robustness only. Population = price at D + trailing-30d DefiLlama revenue >= $1M annualized + in scope (no market cap/volume that far back). Prices on one 00:00 UTC grid, BTC from the same grid. Valuation/size columns are null.",
      "Sector buckets and scope overrides are TODAY's (classification look-ahead; data is point-in-time).",
      "Backfilled rows carry no FDV/supply/TVL: ps/pf are the circulating (market-cap) versions; float, mc_tvl, measured dilution are null.",
    ],
    minutes: +((Date.now() - t0) / 60000).toFixed(1),
  };
  writeFileSync(join(dir, `coverage_${window}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, per_date: coverage.map((c) => ({ date: c.date, universe: c.universe, rated: c.rated, both: c.rated_both_legs, fwd30: c.rated_with_fwd30, fwd90: c.rated_with_fwd90, cg: c.rated_coingecko_priced_at_d, tags: c.tags })) }, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {}; // a module, not a global script
