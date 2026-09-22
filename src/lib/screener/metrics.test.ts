import test from "node:test";
import assert from "node:assert/strict";
import { computeAssetMetrics, ratio, type SnapshotForMetrics } from "./metrics.ts";

const snap = (over: Partial<SnapshotForMetrics> = {}): SnapshotForMetrics => ({
  asset_id: "a1", gecko_id: "some-token", sector: "Lending",
  price_usd: 2, market_cap_usd: 100_000_000, fdv_usd: 200_000_000,
  circulating_supply: 50_000_000, total_supply: 80_000_000, max_supply: 100_000_000,
  tvl_usd: 400_000_000, fees_30d: 3_000_000, revenue_30d: 1_000_000, holders_revenue_30d: 500_000,
  volume_24h_usd: 5_000_000, ...over,
});

test("ratio is null for an unknown input or a non-positive denominator — never 0 or Infinity", () => {
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(1, -5), null);
  assert.equal(ratio(null, 5), null);
  assert.equal(ratio(10, null), null);
  assert.equal(ratio(10, 4), 2.5);
});

test("annualized figures and valuation ratios", () => {
  const m = computeAssetMetrics(snap());
  assert.equal(m.rev_ann, 1_000_000 * 365 / 30);
  assert.equal(m.fees_ann, 3_000_000 * 365 / 30);
  assert.equal(m.ps_circ, 100_000_000 / (1_000_000 * 365 / 30));
  assert.equal(m.pf_fd, 200_000_000 / (3_000_000 * 365 / 30));
  assert.equal(m.float_ratio, 0.5, "circulating / max supply");
  assert.equal(m.mc_tvl, 0.25, "lending bucket uses mc/tvl");
  assert.equal(m.size_log_mcap, Math.log(100_000_000));
});

test("float ratio falls back to total supply when max is unknown", () => {
  assert.equal(computeAssetMetrics(snap({ max_supply: null })).float_ratio, 50_000_000 / 80_000_000);
});

test("mc_tvl is null outside TVL-meaningful buckets", () => {
  assert.equal(computeAssetMetrics(snap({ sector: "Dexs" })).mc_tvl, null);
});

test("capture/buyback_yield are null without a documented mechanism, even when DefiLlama says 0 or more", () => {
  const m = computeAssetMetrics(snap({ gecko_id: "some-token" }));
  assert.equal(m.capture, null);
  assert.equal(m.buyback_yield, null);
  const hype = computeAssetMetrics(snap({ gecko_id: "hyperliquid" }));
  assert.equal(hype.capture, 0.5);
  assert.equal(hype.buyback_yield, (500_000 * 365 / 30) / 100_000_000);
});

test("gates: a clean asset is rated; unlock and collapse are not evaluable in 2a and never fail", () => {
  const m = computeAssetMetrics(snap());
  assert.equal(m.rated, true);
  assert.equal(m.gate_status.unlock_overhang, "not_evaluable");
  assert.equal(m.gate_status.collapsing_revenue, "not_evaluable");
});

test("gates: revenue floor is $1M annualized", () => {
  const justUnder = (1_000_000 * 30) / 365 - 1;
  assert.equal(computeAssetMetrics(snap({ revenue_30d: justUnder })).gate_status.revenue_floor, "fail");
  assert.equal(computeAssetMetrics(snap({ revenue_30d: justUnder + 2 })).gate_status.revenue_floor, "pass");
});

test("gates: missing core data fails; a missing non-core input (volume) is not evaluable, not a fail", () => {
  const noRev = computeAssetMetrics(snap({ revenue_30d: null }));
  assert.equal(noRev.gate_status.core_data, "fail");
  assert.equal(noRev.rated, false);
  const noVol = computeAssetMetrics(snap({ volume_24h_usd: null }));
  assert.equal(noVol.gate_status.liquidity, "not_evaluable");
  assert.equal(noVol.rated, true);
});

test("gates: mcap floor, liquidity and out-of-scope sectors each unrate", () => {
  assert.equal(computeAssetMetrics(snap({ market_cap_usd: 9_000_000 })).rated, false);
  assert.equal(computeAssetMetrics(snap({ volume_24h_usd: 1_000_000 })).rated, false);
  assert.equal(computeAssetMetrics(snap({ sector: "Chain" })).rated, false);
});
