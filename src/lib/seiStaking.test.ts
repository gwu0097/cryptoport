import test from "node:test";
import assert from "node:assert/strict";
import { seiStakingHoldings } from "./seiStaking.ts";

const VAL = "seivaloper1qe8uuf5x69c526h4nzxwv4ltftr73v7q5qhs58";

test("the former Compass wallet's real stake: 1,020 SEI + 75.97 SEI rewards, valued at the wallet's SEI price", () => {
  const h = seiStakingHoldings(
    { delegations: [{ validator: VAL, amountUsei: "1020000000" }], rewards: [{ validator: VAL, amountUsei: "75969692.016229500000000000" }], unbonding: [] },
    new Map([[VAL, "Example Validator"]]),
    0.0616,
    "sei.png",
  );
  assert.deepEqual(
    h.map((x) => [x.protocol_section, x.qty, Math.round(x.usd_override! * 100) / 100, x.display_label]),
    [
      ["Staked", 1020, 62.83, "Staked · Example Validator"],
      ["Rewards", 75.9696920162295, 4.68, "Staking rewards · Example Validator"],
    ],
  );
  assert.ok(h.every((x) => x.ticker === "SEI" && x.chain === "sei" && x.category === "defi" && x.protocol_url.endsWith(VAL)));
});

test("unbonding shows its release date; dust rewards and zeroes are dropped; no price = unpriced, not $0", () => {
  const h = seiStakingHoldings(
    {
      delegations: [{ validator: VAL, amountUsei: "0" }],
      rewards: [{ validator: VAL, amountUsei: "0.4" }],
      unbonding: [{ validator: VAL, amountUsei: "500000000", completionTime: "2026-10-15T12:00:00Z" }],
    },
    new Map(),
    null,
    null,
  );
  assert.equal(h.length, 1);
  assert.equal(h[0].protocol_section, "Unbonding");
  assert.equal(h[0].qty, 500);
  assert.equal(h[0].usd_override, null);
  assert.match(h[0].display_label, /^Unbonding · seivaloper1qe8…hs58 · available 2026-10-15$/);
});
