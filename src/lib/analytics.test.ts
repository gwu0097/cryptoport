import test from "node:test";
import assert from "node:assert/strict";
import { estimateSeries, estimateCoverage, stitchSeries, buildHistoryMap } from "./analytics.ts";

function history(entries: Record<string, Record<string, number>>) {
  return new Map(Object.entries(entries).map(([key, byDate]) => [key, new Map(Object.entries(byDate))]));
}

test("estimateSeries multiplies today's qty by each day's historical price", () => {
  const holdings = [{ ticker: "ETH", price_key: "ethereum", qty: 2 }];
  const priceHistory = history({ ethereum: { "2026-01-01": 2000, "2026-01-02": 2100 } });
  const result = estimateSeries(holdings, priceHistory, ["2026-01-01", "2026-01-02"]);
  assert.deepEqual(result, [
    { date: "2026-01-01", total: 4000 },
    { date: "2026-01-02", total: 4200 },
  ]);
});

test("estimateSeries contributes nothing for a holding missing a price on a given day", () => {
  const holdings = [{ ticker: "ETH", price_key: "ethereum", qty: 2 }];
  const priceHistory = history({ ethereum: { "2026-01-01": 2000 } });
  const result = estimateSeries(holdings, priceHistory, ["2026-01-01", "2026-01-02"]);
  assert.deepEqual(result, [
    { date: "2026-01-01", total: 4000 },
    { date: "2026-01-02", total: 0 },
  ]);
});

test("estimateSeries excludes an unresolvable holding entirely, not as a zero", () => {
  const holdings = [{ ticker: "NOTE", price_key: null, qty: null }];
  const result = estimateSeries(holdings, history({}), ["2026-01-01"]);
  assert.deepEqual(result, [{ date: "2026-01-01", total: 0 }]);
});

test("estimateCoverage: fully covered holdings (key resolves AND has cached data) report 100%", () => {
  const result = estimateCoverage(
    [{ ticker: "ETH", price_key: "ethereum", qty: 2, currentUsd: 4000 }],
    history({ ethereum: { "2026-01-01": 2000 } }),
  );
  assert.equal(result.pct, 100);
  assert.equal(result.coveredUsd, 4000);
  assert.deepEqual(result.unresolvedTickers, []);
  assert.equal(result.unresolvedUsd, 0);
  assert.deepEqual(result.uncachedTickers, []);
  assert.equal(result.uncachedUsd, 0);
});

test("estimateCoverage: a holding with no resolvable key is unresolved, not uncached", () => {
  const result = estimateCoverage(
    [{ ticker: "NOTE", price_key: null, qty: null, currentUsd: 500 }],
    history({}),
  );
  assert.equal(result.pct, 0);
  assert.equal(result.coveredUsd, 0);
  assert.equal(result.totalUsd, 500);
  assert.deepEqual(result.unresolvedTickers, ["NOTE"]);
  assert.equal(result.unresolvedUsd, 500);
  assert.deepEqual(result.uncachedTickers, []);
});

test("estimateCoverage: a key that has never been fetched (no row at all) is uncached, not unresolved", () => {
  // priceHistory.get(key) is undefined — no row in price_history yet.
  // Clicking "Backfill history" again can fetch this one.
  const result = estimateCoverage(
    [{ ticker: "ETH", price_key: "ethereum", qty: 2, currentUsd: 4000 }],
    history({}),
  );
  assert.equal(result.pct, 0);
  assert.deepEqual(result.unresolvedTickers, []);
  assert.deepEqual(result.uncachedTickers, ["ETH"]);
  assert.equal(result.uncachedUsd, 4000);
});

test("estimateCoverage: a key with a cached but empty series is unresolved, not uncached", () => {
  // priceHistory.get(key) exists but is an empty Map — CoinGecko was
  // asked and confirmed it has no data (see priceHistory.ts's 404
  // handling). Re-clicking "Backfill history" would skip this key
  // entirely (it already has a row), so it must NOT be reported as
  // something another click can fix.
  const result = estimateCoverage(
    [{ ticker: "ETH", price_key: "ethereum", qty: 2, currentUsd: 4000 }],
    history({ ethereum: {} }),
  );
  assert.equal(result.pct, 0);
  assert.deepEqual(result.unresolvedTickers, ["ETH"]);
  assert.equal(result.unresolvedUsd, 4000);
  assert.deepEqual(result.uncachedTickers, []);
});

test("estimateCoverage: empty holdings list is 0% of $0, not NaN", () => {
  const result = estimateCoverage([], history({}));
  assert.equal(result.pct, 0);
  assert.equal(result.totalUsd, 0);
});

test("stitchSeries: dates before the real series use the estimate", () => {
  const estimated = [
    { date: "2026-01-01", total: 100 },
    { date: "2026-01-02", total: 110 },
  ];
  const real = [{ date: "2026-01-03", total: 200 }];
  const result = stitchSeries(estimated, real);
  assert.deepEqual(result, [
    { date: "2026-01-01", total: 100, kind: "estimated" },
    { date: "2026-01-02", total: 110, kind: "estimated" },
    { date: "2026-01-03", total: 200, kind: "real" },
  ]);
});

test("stitchSeries: real wins on a date both series have", () => {
  const estimated = [{ date: "2026-01-01", total: 100 }];
  const real = [{ date: "2026-01-01", total: 999 }];
  const result = stitchSeries(estimated, real);
  assert.deepEqual(result, [{ date: "2026-01-01", total: 999, kind: "real" }]);
});

test("stitchSeries: a single-date series on each side still stitches in order", () => {
  const result = stitchSeries([{ date: "2026-01-01", total: 1 }], [{ date: "2026-01-02", total: 2 }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].date, "2026-01-01");
  assert.equal(result[1].date, "2026-01-02");
});

test("stitchSeries: an estimated point after the first real date is dropped, not interleaved", () => {
  // A day the cron missed, or a newly-backfilled token whose 365-day window
  // extends past the seam — either way, nothing after the first real
  // snapshot should ever come from the estimate, even a "gap" day.
  const estimated = [
    { date: "2026-01-01", total: 100 },
    { date: "2026-01-02", total: 110 },
    { date: "2026-01-03", total: 120 }, // would otherwise fill a cron-missed day
    { date: "2026-01-04", total: 130 },
  ];
  const real = [
    { date: "2026-01-02", total: 200 },
    // 2026-01-03 missing — the cron didn't run that day
    { date: "2026-01-04", total: 220 },
  ];
  const result = stitchSeries(estimated, real);
  assert.deepEqual(result, [
    { date: "2026-01-01", total: 100, kind: "estimated" },
    { date: "2026-01-02", total: 200, kind: "real" },
    { date: "2026-01-04", total: 220, kind: "real" },
  ]);
});

test("stitchSeries: an empty real series leaves everything estimated", () => {
  const result = stitchSeries([{ date: "2026-01-01", total: 1 }], []);
  assert.deepEqual(result, [{ date: "2026-01-01", total: 1, kind: "estimated" }]);
});

test("estimateCoverage: a non-CoinGecko asset with no daily closes yet is unresolved (backfill can't help)", () => {
  const result = estimateCoverage([{ ticker: "WIF", price_key: "jup:mint", qty: 10, currentUsd: 30 }], history({}));
  assert.equal(result.uncachedUsd, 0);
  assert.equal(result.unresolvedUsd, 30);
});

test("buildHistoryMap: old-key history, then the key's own, then daily closes (later wins); no layer = absent", () => {
  const map = buildHistoryMap(
    new Map([
      ["morpho", new Set(["ethereum:0xmorpho"])],
      ["jup:mint", new Set<string>()],
      ["never", new Set<string>()],
      ["empty", new Set<string>()],
    ]),
    new Map<string, Record<string, number>>([
      ["ethereum:0xmorpho", { "2026-01-01": 1, "2026-01-02": 2 }],
      ["morpho", { "2026-01-02": 2.5 }],
      ["empty", {}],
    ]),
    new Map([
      ["morpho", [["2026-01-03", 3]] as [string, number][]],
      ["jup:mint", [["2026-01-03", 0.5]] as [string, number][]],
    ]),
  );
  assert.deepEqual([...map.get("morpho")!], [["2026-01-01", 1], ["2026-01-02", 2.5], ["2026-01-03", 3]]);
  assert.deepEqual([...map.get("jup:mint")!], [["2026-01-03", 0.5]]);
  assert.equal(map.has("never"), false);
  assert.equal(map.get("empty")!.size, 0); // CoinGecko confirmed none: present but empty
});

test("estimateCoverage: a price only from the real-snapshot start on (a daily close) covers nothing; an unfetched coin stays backfillable", () => {
  const holdings = [
    { ticker: "ETH", price_key: "ethereum", qty: 2, currentUsd: 4000 },
    { ticker: "WIF", price_key: "jup:mint", qty: 10, currentUsd: 30 },
    { ticker: "BTC", price_key: "bitcoin", qty: 1, currentUsd: 100 },
  ];
  const priceHistory = history({
    ethereum: { "2026-09-25": 2000 }, // close only
    "jup:mint": { "2026-09-25": 3 }, // close only, not backfillable
    bitcoin: { "2026-08-01": 90, "2026-09-25": 100 }, // backfilled
  });
  const result = estimateCoverage(holdings, priceHistory, { before: "2026-09-14", fetched: new Set(["bitcoin"]) });
  assert.equal(result.coveredUsd, 100);
  assert.deepEqual(result.uncachedTickers, ["ETH"]);
  assert.deepEqual(result.unresolvedTickers, ["WIF"]);
});
