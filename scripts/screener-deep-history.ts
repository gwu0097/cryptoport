// Phase 4a: the deep-history store for the 2- and 3-year backtest windows
// (PHASE_4_PLAN.md, decision 2). DefiLlama only — ZERO CoinGecko calls.
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/screener-deep-history.ts [--limit N]
//
// Writes to ~/cryptoport-archive/screener/deep/ (SCREENER_ARCHIVE_DIR/deep):
//   deep_prices.parquet    gecko_id, date, price_usd — every known asset +
//                          bitcoin, ONE fixed 00:00 UTC grid (every /chart
//                          call starts at 00:00, so every point, BTC's
//                          included, sits on the same moment of its day —
//                          the same-moment pairing rule; SPEC "levels")
//   deep_revenue.parquet   gecko_id, date, revenue_usd — daily revenue per
//                          asset, summed across its contributing slugs (the
//                          live job's own membership, same sum as backfill)
//   manifest.json          grid, span, counts, call counts, content hashes
// Both files are read back and fingerprint-checked before being kept.
//
// Resumable: progress goes to checkpoint JSONL files first (one line per
// asset), and assets already in a checkpoint are skipped — a killed run
// resumes without refetching. Two serial streams run in parallel, one per
// DefiLlama host (coins.llama.fi prices: 1.5s between calls, owned by
// fetchChartPrices; api.llama.fi fees: 1s between calls here).
//
// Span: 3 years + a 120-day lookback (mom_12w's 84 days + beta's 90 with
// tolerance), ending YESTERDAY (today's partial day is never stored — SPEC
// flows/levels rule; the backfill rule).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.loadEnvFile(`${__dirname}/../.env.local`);

const SPAN_DAYS = 3 * 365 + 120;
const PRICE_BATCH = 20; // coins per /chart chain; the span per call is sized by fetchChartPrices (500 points / coins)
const FEES_THROTTLE_MS = 1000;

async function main() {
  const { serviceDb } = await import("../src/lib/supabase");
  const { fetchChartPrices } = await import("../src/lib/screener/adapters/defillamaPrices");
  const { fetchProtocolFeeHistory } = await import("../src/lib/screener/adapters/defillama");
  const { sumDailySeriesAcrossSlugs } = await import("../src/lib/screener/aggregate");
  const { latestDailyRun } = await import("../src/lib/screener/runSelection");
  const { writeParquetVerified } = await import("../src/lib/screener/archive");
  const { fetchAllRows } = await import("../src/lib/screener/pagination");

  const dir = join(process.env.SCREENER_ARCHIVE_DIR ?? join(homedir(), "cryptoport-archive", "screener"), "deep");
  mkdirSync(dir, { recursive: true });
  const pricesCkpt = join(dir, "prices.checkpoint.jsonl");
  const revenueCkpt = join(dir, "revenue.checkpoint.jsonl");
  const readCkpt = (path: string) =>
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { gecko_id: string; points: [string, number][] })
      : [];

  // The grid: 00:00 UTC, SPAN_DAYS before yesterday.
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - SPAN_DAYS);
  const startEpoch = Math.floor(start.getTime() / 1000);

  // Assets and their slugs: the latest complete live run's membership.
  const db = serviceDb();
  const { data: runs, error: runsError } = await db
    .from("screener_runs")
    .select("id, started_at, status, kind, degraded")
    .eq("kind", "live")
    .order("started_at", { ascending: false })
    .limit(30);
  if (runsError) throw new Error(runsError.message);
  const run = latestDailyRun(runs ?? []);
  if (!run) throw new Error("no ok live run");
  const members = await fetchAllRows<{ id: string; contributing_slugs: string[] | null; screener_assets: { gecko_id: string } | null }>(
    async (cursor, limit) =>
      db
        .from("screener_asset_snapshots")
        .select("id, contributing_slugs, screener_assets(gecko_id)")
        .eq("run_id", run.id)
        .gt("id", cursor)
        .order("id")
        .limit(limit) as never,
  );
  const slugsByGecko = new Map<string, string[]>();
  for (const m of members) if (m.screener_assets && m.contributing_slugs?.length) slugsByGecko.set(m.screener_assets.gecko_id, m.contributing_slugs);
  // --limit N: smoke test on bitcoin + the first N assets (use a scratch SCREENER_ARCHIVE_DIR).
  const limitAt = process.argv.indexOf("--limit");
  if (limitAt !== -1) {
    const keep = new Set([...slugsByGecko.keys()].sort().slice(0, Number(process.argv[limitAt + 1])));
    for (const id of [...slugsByGecko.keys()]) if (!keep.has(id)) slugsByGecko.delete(id);
  }
  const geckoIds = [...new Set(["bitcoin", ...slugsByGecko.keys()])].sort();
  console.log(`run ${run.id}: ${geckoIds.length} coins (incl. bitcoin), grid start ${start.toISOString()}, ${SPAN_DAYS} days`);

  let priceCalls = 0;
  let feeCalls = 0;
  const pricesStream = async () => {
    const done = new Set(readCkpt(pricesCkpt).map((r) => r.gecko_id));
    const todo = geckoIds.filter((id) => !done.has(id));
    console.log(`[prices] ${done.size} done, ${todo.length} to fetch`);
    for (let i = 0; i < todo.length; i += PRICE_BATCH) {
      const batch = todo.slice(i, i + PRICE_BATCH);
      const got = await fetchChartPrices(batch, startEpoch, SPAN_DAYS);
      priceCalls += Math.ceil(SPAN_DAYS / Math.floor(500 / batch.length));
      // Every coin in the batch gets a line, even with no points (a real "none").
      appendFileSync(
        pricesCkpt,
        batch.map((id) => JSON.stringify({ gecko_id: id, points: (got.get(id) ?? []).filter((p) => p.date < today).map((p) => [p.date, p.priceUsd]) })).join("\n") + "\n",
      );
      console.log(`[prices] ${Math.min(i + PRICE_BATCH, todo.length)}/${todo.length}`);
    }
  };
  const revenueStream = async () => {
    const done = new Set(readCkpt(revenueCkpt).map((r) => r.gecko_id));
    const todo = [...slugsByGecko.keys()].filter((id) => !done.has(id)).sort();
    console.log(`[revenue] ${done.size} done, ${todo.length} to fetch`);
    let n = 0;
    for (const id of todo) {
      const slugs = slugsByGecko.get(id)!;
      const series = new Map<string, { date: string; value: number }[]>();
      for (const slug of slugs) {
        await new Promise((r) => setTimeout(r, FEES_THROTTLE_MS));
        series.set(slug, await fetchProtocolFeeHistory(slug, "dailyRevenue"));
        feeCalls++;
      }
      const summed = sumDailySeriesAcrossSlugs(slugs, series).filter((p) => p.date < today);
      appendFileSync(revenueCkpt, JSON.stringify({ gecko_id: id, points: summed.map((p) => [p.date, p.value]) }) + "\n");
      if (++n % 25 === 0 || n === todo.length) console.log(`[revenue] ${n}/${todo.length}`);
    }
  };
  const t0 = Date.now();
  await Promise.all([pricesStream(), revenueStream()]);

  const toRows = (ckpt: string, valueCol: string) =>
    readCkpt(ckpt).flatMap((r) => r.points.map(([date, v]) => ({ gecko_id: r.gecko_id, date, [valueCol]: v })));
  const priceRows = toRows(pricesCkpt, "price_usd");
  const revenueRows = toRows(revenueCkpt, "revenue_usd");
  const priceSha = await writeParquetVerified(join(dir, "deep_prices.parquet"), priceRows, [
    { name: "gecko_id", type: "STRING" },
    { name: "date", type: "STRING" },
    { name: "price_usd", type: "DOUBLE" },
  ]);
  const revenueSha = await writeParquetVerified(join(dir, "deep_revenue.parquet"), revenueRows, [
    { name: "gecko_id", type: "STRING" },
    { name: "date", type: "STRING" },
    { name: "revenue_usd", type: "DOUBLE" },
  ]);
  const withPrices = new Set(priceRows.map((r) => r.gecko_id)).size;
  const manifest = {
    written_at: new Date().toISOString(),
    membership_run_id: run.id,
    grid: "00:00 UTC (every /chart call starts at 00:00)",
    start_date: start.toISOString().slice(0, 10),
    end_before: today,
    span_days: SPAN_DAYS,
    coins: geckoIds.length,
    coins_with_any_price: withPrices,
    price_rows: priceRows.length,
    revenue_assets: new Set(revenueRows.map((r) => r.gecko_id)).size,
    revenue_rows: revenueRows.length,
    calls_this_session: { coins_llama_chart_estimate: priceCalls, api_llama_summary_fees: feeCalls, coingecko: 0 },
    content_sha256: { deep_prices: priceSha, deep_revenue: revenueSha },
    minutes_this_session: +((Date.now() - t0) / 60000).toFixed(1),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {}; // a module, not a global script
