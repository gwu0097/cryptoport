import test from "node:test";
import assert from "node:assert/strict";
import { comboLabel, comboValue, isHeldCombo, type ComboLeg, type ComboPosition } from "./polymarketCombos.ts";

const leg = (pick: string, price: number | string, status = "OPEN"): ComboLeg => ({
  leg_status: status,
  leg_current_price: price,
  leg_outcome_label: pick,
  market: { title: `${pick} game` },
});

// BizNFT's 10-leg NFL combo as Polymarket's /v2/positions/combos returned it,
// 2026-10-16 21:55 UTC ($15 paid, $14.29 after fees).
const NFL: ComboPosition = {
  combo_condition_id: "0x03d0ed3936cd6bbc289a2b6c5aed6f23810000000000000000000000000000",
  current_size: 975.949235,
  entry_avg_price_usdc: 0.014647,
  entry_cost_usdc: 14.294728,
  status: "OPEN",
  redeemable: false,
  legs_total: 10,
  legs_resolved: 0,
  legs: [
    leg("Colts", 0.735), leg("Falcons", 0.495), leg("Bills", 0.675), leg("Rams", 0.875), leg("Saints", 0.515),
    leg("Jaguars", 0.565), leg("Chiefs", 0.775), leg("Ravens", 0.615), leg("Patriots", 0.755), leg("Steelers", 0.555),
  ],
};

test("an open combo is worth shares × the product of its legs' prices", () => {
  const v = comboValue(NFL);
  assert.equal(v.shares, 975.949235);
  assert.ok(Math.abs(v.usd! - 12.19) < 0.01, String(v.usd));
  assert.equal(v.cost, 14.294728);
});

test("a won leg counts 1, a lost leg makes the combo 0", () => {
  const won = { ...NFL, legs_resolved: 1, legs: [leg("Colts", 1, "RESOLVED_WIN"), ...NFL.legs.slice(1)] };
  assert.ok(comboValue(won).usd! > comboValue(NFL).usd!);
  const lost = { ...NFL, legs: [leg("Colts", 0, "RESOLVED_LOSS"), ...NFL.legs.slice(1)] };
  assert.equal(comboValue(lost).usd, 0);
});

test("an open leg with no price leaves the value unknown, never 0", () => {
  const v = comboValue({ ...NFL, legs: [leg("Colts", "0"), ...NFL.legs.slice(1)] });
  assert.equal(v.usd, null);
});

test("a won combo waiting to be redeemed is worth its shares", () => {
  assert.equal(comboValue({ ...NFL, status: "RESOLVED_WIN", current_size: "100" }).usd, 100);
});

test("held: shares left and not lost", () => {
  assert.equal(isHeldCombo(NFL), true);
  assert.equal(isHeldCombo({ ...NFL, status: "RESOLVED_LOSS" }), false);
  assert.equal(isHeldCombo({ ...NFL, current_size: 0 }), false);
});

test("label lists the picks and how many legs settled", () => {
  assert.equal(comboLabel(NFL), "10-leg combo: Colts, Falcons, Bills, Rams, …");
  assert.equal(comboLabel({ ...NFL, legs: NFL.legs.slice(0, 2), legs_total: 2, legs_resolved: 1 }), "2-leg combo: Colts, Falcons (1 of 2 settled)");
});
