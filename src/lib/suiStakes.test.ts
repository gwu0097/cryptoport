import test from "node:test";
import assert from "node:assert/strict";
import { stakesToHoldings, mistToSui, normalizeSuiCoinType, estimateStakeReward } from "./suiStakes.ts";

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

test("GraphQL's full-length system package types map back to the short form rows use", () => {
  assert.equal(normalizeSuiCoinType("0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"), "0x2::sui::SUI");
  const hasui = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
  assert.equal(normalizeSuiCoinType(hasui), hasui);
});

test("stake reward from the pool's exchange rates: the real 300 SUI ZKV stake ≈ 19 SUI (JSON-RPC said 19.004)", () => {
  const reward = estimateStakeReward(
    BigInt(300_000_000_000),
    { sui_amount: "30074028117182834", pool_token_amount: "30008874069696169" }, // epoch 260
    { sui_balance: "22884148050390339", pool_token_balance: "21473484570836549" },
  );
  const sui = Number(reward) / 1e9;
  assert.ok(sui > 18.9 && sui < 19.1, String(sui));
  assert.equal(estimateStakeReward(BigInt(5), { sui_amount: "10", pool_token_amount: "10" }, { sui_balance: "9", pool_token_balance: "10" }), BigInt(0), "never negative");
});
