import test from "node:test";
import assert from "node:assert/strict";
import {
  dailyReadings,
  pairBtc,
  momentumVsBtc,
  betaVsBtc,
  revenue90d,
  annualizedGrowth,
  computeHistoryMetrics,
  shiftDate,
  type Reading,
  type BtcReference,
} from "./history.ts";

const r = (date: string, over: Partial<Reading> = {}): Reading => ({
  observed_at: `${date}T12:00:00.000Z`,
  is_backfilled: true,
  run_id: "backfill-run",
  price_usd: 1,
  market_cap_usd: 100,
  circulating_supply: null,
  revenue_30d: 30,
  ...over,
});

const noBtc: BtcReference = { backfillGridByRun: new Map(), midnight: new Map(), byRun: new Map() };

// ---- BTC pairing: the silent-bias guard (SPEC standing rule, levels case) ----

const ref = (over: Partial<BtcReference> = {}): BtcReference => ({
  backfillGridByRun: new Map(),
  midnight: new Map(),
  byRun: new Map(),
  ...over,
});

test("pairBtc: a backfilled DefiLlama-priced row pairs with BTC on its own backfill run's time-of-day grid", () => {
  const btc = ref({
    backfillGridByRun: new Map([["backfill-run", new Map([["2026-09-01", 101]])]]),
    midnight: new Map([["2026-09-01", 100]]),
  });
  assert.equal(pairBtc(r("2026-09-01"), btc), 101);
});

test("pairBtc: a backfilled CoinGecko-priced row (00:00 point) pairs with BTC at 00:00", () => {
  const btc = ref({
    backfillGridByRun: new Map([["backfill-run", new Map([["2026-09-01", 101]])]]),
    midnight: new Map([["2026-09-01", 100]]),
  });
  assert.equal(pairBtc(r("2026-09-01", { price_from_coingecko: true }), btc), 100);
});

test("pairBtc: a live reading pairs with BTC read at that run's moment", () => {
  const btc = ref({ midnight: new Map([["2026-09-23", 100]]), byRun: new Map([["live-run", 107]]) });
  const live = r("2026-09-23", { observed_at: "2026-09-23T07:00:05.000Z", is_backfilled: false, run_id: "live-run" });
  assert.equal(pairBtc(live, btc), 107);
});

test("pairBtc: no same-moment BTC price means null — never a fallback to a different moment", () => {
  const live = r("2026-09-23", { observed_at: "2026-09-23T07:00:05.000Z", is_backfilled: false, run_id: "unknown-run" });
  assert.equal(pairBtc(live, ref({ midnight: new Map([["2026-09-23", 100]]) })), null);
  assert.equal(pairBtc(r("2026-09-01", { run_id: "other-backfill" }), ref({ midnight: new Map([["2026-09-01", 100]]) })), null);
});

test("pairing at the wrong moment biases momentum: a live reading vs a daily point", () => {
  // Asset flat vs BTC: BTC 100 at the start, 110 at the live 07:00 read, and
  // the asset moved with it. Correct pairing: momentum 0.
  const readings = [
    r("2026-09-02", { price_usd: 1 }),
    r("2026-09-23", { observed_at: "2026-09-23T07:00:00.000Z", is_backfilled: false, run_id: "live", price_usd: 1.1 }),
  ];
  const byDay = dailyReadings(readings, "2026-09-23T07:00:00.000Z");
  const grid = new Map([["backfill-run", new Map([["2026-09-02", 100]])]]);
  const right = ref({ backfillGridByRun: grid, byRun: new Map([["live", 110]]) });
  assert.ok(Math.abs(momentumVsBtc(byDay, "2026-09-23", 21, 2, right)!) < 1e-12);
  const wrong = ref({ backfillGridByRun: grid, byRun: new Map([["live", 100]]) }); // BTC from the wrong moment
  assert.ok(Math.abs(momentumVsBtc(byDay, "2026-09-23", 21, 2, wrong)! - 0.1) < 1e-12);
});

test("pairing at the wrong time of day collapses beta — the bug the first 2b run hit", () => {
  // Asset = 2x BTC's log return at every 21:31 reading. BTC sampled at 00:00
  // instead (~21.5h earlier, i.e. mostly the PREVIOUS day's move) destroys
  // the relationship even though both are "daily points".
  const readings: Reading[] = [];
  const grid = new Map<string, number>();
  const midnight = new Map<string, number>();
  let btc2131 = 100;
  let px = 1;
  for (let i = 0; i < 91; i++) {
    const d = shiftDate("2026-06-24", i);
    midnight.set(d, btc2131); // yesterday's 21:31 level ≈ today's 00:00
    const ret = 0.02 * Math.sin(i * 1.7);
    btc2131 *= Math.exp(ret);
    px *= Math.exp(2 * ret);
    grid.set(d, btc2131);
    readings.push(r(d, { price_usd: px }));
  }
  const byDay = dailyReadings(readings, "2026-09-23T00:00:00.000Z");
  const right = betaVsBtc(byDay, "2026-09-22", 90, 60, ref({ backfillGridByRun: new Map([["backfill-run", grid]]) }))!;
  assert.ok(Math.abs(right - 2) < 1e-9);
  const wrongGrid = new Map([["backfill-run", midnight]]); // the pre-fix pairing
  const wrong = betaVsBtc(byDay, "2026-09-22", 90, 60, ref({ backfillGridByRun: wrongGrid }))!;
  assert.ok(Math.abs(wrong) < 1, `misaligned beta ${wrong} should collapse far below 2`);
});

// ---- point-in-time + day handling ----

test("dailyReadings keeps the latest reading per day and never looks past asOf", () => {
  const readings = [
    r("2026-09-22", { observed_at: "2026-09-22T16:43:00.000Z", price_usd: 1 }),
    r("2026-09-22", { observed_at: "2026-09-22T23:05:00.000Z", price_usd: 2 }),
    r("2026-09-23", { observed_at: "2026-09-23T07:00:00.000Z", price_usd: 3 }),
  ];
  const byDay = dailyReadings(readings, "2026-09-22T23:59:59.000Z");
  assert.equal(byDay.get("2026-09-22")!.price_usd, 2);
  assert.equal(byDay.has("2026-09-23"), false);
});

// ---- metrics ----

test("momentum is the ratio form and uses the ±tolerance for the start date", () => {
  const btc: BtcReference = { backfillGridByRun: new Map([["backfill-run", new Map([["2026-09-01", 100], ["2026-09-23", 120]])]]), midnight: new Map(), byRun: new Map() };
  const byDay = dailyReadings([r("2026-09-01", { price_usd: 10 }), r("2026-09-23", { price_usd: 18 })], "2026-09-24T00:00:00.000Z");
  // 21 days back from 09-23 is 09-02; the only reading is 09-01, within ±2.
  assert.ok(Math.abs(momentumVsBtc(byDay, "2026-09-23", 21, 2, btc)! - (18 / 10 / (120 / 100) - 1)) < 1e-12);
  assert.equal(momentumVsBtc(byDay, "2026-09-23", 21, 0, btc), null, "outside tolerance -> null");
});

test("beta: a token that moves exactly 2x BTC's daily log return has beta 2; too few pairs is null", () => {
  const readings: Reading[] = [];
  const daily = new Map<string, number>();
  let btcPx = 100;
  let px = 1;
  for (let i = 0; i < 91; i++) {
    const d = shiftDate("2026-06-24", i);
    const ret = 0.01 * Math.sin(i);
    btcPx *= Math.exp(ret);
    px *= Math.exp(2 * ret);
    daily.set(d, btcPx);
    readings.push(r(d, { price_usd: px }));
  }
  const btc: BtcReference = { backfillGridByRun: new Map([["backfill-run", daily]]), midnight: new Map(), byRun: new Map() };
  const byDay = dailyReadings(readings, "2026-09-23T00:00:00.000Z");
  assert.ok(Math.abs(betaVsBtc(byDay, "2026-09-22", 90, 60, btc)! - 2) < 1e-9);
  assert.equal(betaVsBtc(byDay, "2026-09-22", 90, 95, btc), null);
});

test("90-day revenue sums the rolling 30-day totals at t, t-30, t-60; any gap is null", () => {
  const byDay = dailyReadings(
    [r("2026-09-22", { revenue_30d: 30 }), r("2026-08-23", { revenue_30d: 20 }), r("2026-07-23", { revenue_30d: 10 })],
    "2026-09-23T00:00:00.000Z",
  );
  assert.equal(revenue90d(byDay, "2026-09-22", 2), 60);
  assert.equal(revenue90d(byDay, "2026-09-22", 0), null, "the t-60 point (07-24) only exists a day off, so exact matching finds a gap");
});

test("annualized growth uses the real gap and refuses non-positive supply", () => {
  assert.ok(Math.abs(annualizedGrowth(100, 110, 365)! - 0.1) < 1e-12);
  assert.equal(annualizedGrowth(0, 110, 90), null);
  assert.equal(annualizedGrowth(100, null, 90), null);
});

test("computeHistoryMetrics: measured dilution needs LIVE supply at both ends; implied uses mcap/price", () => {
  const cfg = { lookbackToleranceDays: 2, betaDays: 90, betaMinPairs: 60, dilutionDays: 90, dilutionToleranceDays: 3 };
  const readings = [
    r("2026-06-24", { market_cap_usd: 100, price_usd: 1 }), // implied supply 100
    r("2026-09-22", { observed_at: "2026-09-22T07:00:00.000Z", is_backfilled: false, run_id: "live", market_cap_usd: 110, price_usd: 1, circulating_supply: 110 }),
  ];
  const m = computeHistoryMetrics(readings, "2026-09-22T07:00:00.000Z", noBtc, cfg);
  assert.equal(m.dilution_rate, null, "no live supply 90 days back -> measured stays null (tier can't fire)");
  assert.ok(m.dilution_rate_implied! > 0.4 && m.dilution_rate_implied! < 0.5, "10% over ~90 days annualizes to ~47%");
});
