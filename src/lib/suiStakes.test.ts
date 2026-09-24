import test from "node:test";
import assert from "node:assert/strict";
import { stakesToHoldings, mistToSui } from "./suiStakes.ts";

const V = "0x4c27adaf06" + "0".repeat(54);

test("the Ledger SUI wallet's real stake: 300 SUI principal + 19.0036 SUI rewards with ZKV", () => {
  const h = stakesToHoldings(
    [{ validatorAddress: V, stakes: [{ principal: "300000000000", estimatedReward: "19003597179", status: "Active" }] }],
    new Map([[V, "ZKV"]]),
    "sui.png",
  );
  assert.deepEqual(
    h.map((x) => [x.protocol_section, x.qty, x.display_label]),
    [
      ["Staked", 300, "Staked · ZKV"],
      ["Rewards", 19.003597179, "Staking rewards · ZKV"],
    ],
  );
  assert.ok(h.every((x) => x.ticker === "SUI" && x.category === "defi" && x.chain === "sui" && x.protocol_url.endsWith(V)));
});

test("stakes are summed per validator; pending ones are labeled; unstaked ones and zeroes are dropped; unknown names shortened", () => {
  const h = stakesToHoldings(
    [
      {
        validatorAddress: V,
        stakes: [
          { principal: "1000000000", estimatedReward: "5", status: "Active" },
          { principal: "2000000000", status: "Pending" },
          { principal: "9000000000", status: "Unstaked" },
        ],
      },
      { validatorAddress: "0xdead" + "0".repeat(60), stakes: [{ principal: "0", status: "Active" }] },
    ],
    new Map(),
    null,
  );
  assert.equal(h.length, 2);
  assert.equal(h[0].qty, 3);
  assert.match(h[0].display_label, /^Staked · 0x4c27ad…0000 \(activates next epoch\)$/);
  assert.equal(h[1].qty, 5e-9);
});

test("mistToSui is exact for large amounts", () => {
  assert.equal(mistToSui(BigInt("123456789012345678")), 123456789.012345678);
});
