import test from "node:test";
import assert from "node:assert/strict";
import { formationDates, buildPeriod, type PanelAsset, type PanelReading } from "./backtest.ts";
import { SCREENER_CONFIG } from "./config.ts";
import { shiftDate, type BtcReference } from "./history.ts";

test("formationDates: D_last = last data date − horizon, stepping back until the first ineligible date (excluded), oldest first", () => {
  const eligible = (d: string) => d >= "2025-12-15";
  const d30 = formationDates("2026-09-21", 30, 30, eligible);
  assert.equal(d30.at(-1), "2026-08-22");
  assert.equal(d30[0], "2025-12-25");
  assert.equal(d30.length, 9);
  for (let i = 1; i < d30.length; i++) assert.equal(shiftDate(d30[i - 1], 30), d30[i], "exactly 30 days apart");
  assert.deepEqual(formationDates("2026-09-21", 90, 90, eligible), ["2025-12-25", "2026-03-25", "2026-06-23"]);
});

// A daily series on one backfill run's grid, for `days` days ending `end`.
const RUN = "bf-run";
function series(end: string, days: number, price: (i: number) => number, over: Partial<PanelReading> = {}): PanelReading[] {
  return Array.from({ length: days }, (_, i) => ({
    observed_at: `${shiftDate(end, i - days + 1)}T21:31:00.000Z`,
    is_backfilled: true,
    run_id: RUN,
    price_usd: price(i),
    market_cap_usd: 500_000_000,
    circulating_supply: null,
    revenue_30d: 3_000_000,
    volume_24h_usd: 10_000_000,
    fees_30d: 6_000_000,
    holders_revenue_30d: null,
    ...over,
  }));
}
const END = "2026-06-30";
const DAYS = 200;
const btcGrid = new Map(Array.from({ length: DAYS }, (_, i) => [shiftDate(END, i - DAYS + 1), 100 * (1 + 0.001 * i)] as [string, number]));
const btc: BtcReference = { backfillGridByRun: new Map([[RUN, btcGrid]]), midnight: new Map(), byRun: new Map() };
const asset = (id: string, price: (i: number) => number, over: Partial<PanelReading> = {}): PanelAsset => ({
  asset_id: id,
  gecko_id: id,
  sector: "Lending",
  readings: series(END, DAYS, price, over),
});

test("buildPeriod: forward return vs BTC is the ratio form, from exactly D and D+30", () => {
  const D = shiftDate(END, -60);
  const rows = buildPeriod(D, [asset("a", (i) => 10 * (1 + 0.002 * i))], btc);
  const r = rows[0];
  const i0 = DAYS - 1 - 60;
  const i1 = i0 + 30;
  const want = (10 * (1 + 0.002 * i1)) / (10 * (1 + 0.002 * i0)) / ((100 * (1 + 0.001 * i1)) / (100 * (1 + 0.001 * i0))) - 1;
  assert.ok(Math.abs(r.fwd30_btc! - want) < 1e-12);
  assert.equal(r.fwd90_btc, null, "D+90 is past the data: null, not a nearby day");
  assert.equal(r.price_d, 10 * (1 + 0.002 * i0));
  assert.equal(r.btc_d, 100 * (1 + 0.001 * i0), "same-moment BTC from the asset's own backfill grid");
});

test("buildPeriod: a missing reading on D+30 excludes the forward return — no nearby-day substitution", () => {
  const D = shiftDate(END, -60);
  const a = asset("gap", () => 5);
  a.readings = a.readings.filter((r) => !r.observed_at.startsWith(shiftDate(D, 30)));
  assert.equal(buildPeriod(D, [a], btc)[0].fwd30_btc, null);
});

test("buildPeriod: scores the rated set through scoreRun, and the EW basket subtracts the RATED mean only", () => {
  const D = shiftDate(END, -60);
  const assets = [
    asset("up", (i) => 10 * (1 + 0.004 * i)),
    asset("flat", () => 10),
    asset("down", (i) => 10 * (1 - 0.001 * i)),
    asset("tiny", (i) => 10 * (1 + 0.01 * i), { market_cap_usd: 1_000_000 }), // fails the $10M floor: unrated
  ];
  const rows = buildPeriod(D, assets, btc);
  const by = new Map(rows.map((r) => [r.gecko_id, r]));
  assert.equal(by.get("tiny")!.rated, false);
  assert.match(by.get("tiny")!.gates_failed, /mcap_floor/);
  assert.equal(by.get("tiny")!.timing_score, null, "unrated assets are not scored");
  assert.ok(by.get("up")!.timing_percentile! > by.get("down")!.timing_percentile!, "higher momentum ranks higher");
  const raw = (g: string) => by.get(g)!.price_d30! / by.get(g)!.price_d! - 1;
  const ratedMean = (raw("up") + raw("flat") + raw("down")) / 3;
  assert.ok(Math.abs(by.get("flat")!.fwd30_ew! - (raw("flat") - ratedMean)) < 1e-12);
  assert.ok(Math.abs(by.get("tiny")!.fwd30_ew! - (raw("tiny") - ratedMean)) < 1e-12, "unrated rows still get an EW figure against the rated mean");
});

test("buildPeriod: point-in-time — a price after D can't change any factor at D", () => {
  const D = shiftDate(END, -60);
  const base = asset("x", (i) => 10 * (1 + 0.003 * i));
  const spiked: PanelAsset = { ...base, readings: base.readings.map((r) => (r.observed_at.slice(0, 10) > D ? { ...r, price_usd: r.price_usd! * 50 } : r)) };
  const [a] = buildPeriod(D, [base], btc);
  const [b] = buildPeriod(D, [spiked], btc);
  for (const k of ["mom_3w", "mom_12w", "beta_btc", "ps_circ", "size_log_mcap", "timing_score"] as const) assert.equal(b[k], a[k], k);
  assert.notEqual(b.fwd30_btc, a.fwd30_btc, "only the forward return sees the future");
});

test("buildPeriod 'deep' population: no market cap or volume needed — price, trailing revenue over the floor, in scope", () => {
  const D = shiftDate(END, -60);
  const noMcap = { market_cap_usd: null, volume_24h_usd: null };
  const rows = buildPeriod(
    D,
    [
      asset("earner", (i) => 10 * (1 + 0.002 * i), noMcap),
      asset("small", (i) => 10 * (1 + 0.002 * i), { ...noMcap, revenue_30d: 10_000 }), // $0.12M/yr < $1M floor
      { ...asset("chain", (i) => 10 * (1 + 0.002 * i), noMcap), sector: "Chain" },
    ],
    btc,
    SCREENER_CONFIG,
    "deep",
  );
  const by = new Map(rows.map((r) => [r.gecko_id, r]));
  assert.equal(by.get("earner")!.rated, true, "in the deep population without market cap");
  assert.notEqual(by.get("earner")!.timing_score, null, "and scored through scoreRun");
  assert.equal(by.get("small")!.rated, false);
  assert.equal(by.get("chain")!.rated, false, "out of scope stays out");
  assert.equal(buildPeriod(D, [asset("earner", (i) => 10 * (1 + 0.002 * i), noMcap)], btc)[0].rated, false, "the production 'rated' rule would fail it (no market cap)");
});
