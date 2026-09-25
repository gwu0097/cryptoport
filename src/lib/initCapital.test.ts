import test from "node:test";
import assert from "node:assert/strict";
import { initHoldings } from "./initCapital.ts";

const METH = "0xcda86a272531e8640cd7f1a92c01839911b90bb0";
const USDC = "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9";
const tokens = new Map([
  [METH, { symbol: "mETH", decimals: 18 }],
  [USDC, { symbol: "USDC", decimals: 6 }],
]);

test("a deposit is a coin quantity in its underlying (the owner's mETH, live before withdrawal)", () => {
  const rows = initHoldings("mnt", [{ posId: "3372…2369", collateral: [{ underlying: METH, amount: BigInt("533674771706478153") }], borrows: [] }], tokens);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "mETH");
  assert.ok(Math.abs(rows[0].qty! - 0.533674771706478) < 1e-12);
  assert.deepEqual([rows[0].contract, rows[0].protocol, rows[0].protocol_section, rows[0].usd_override, rows[0].display_label], [METH, "INIT Capital", "Deposit", null, null]);
});

test("a borrow is a negative quantity; empty positions and zero amounts are skipped; several positions are labeled", () => {
  const rows = initHoldings(
    "mnt",
    [
      { posId: "111111", collateral: [{ underlying: METH, amount: BigInt(10) ** BigInt(18) }], borrows: [{ underlying: USDC, amount: BigInt(250_000_000) }] },
      { posId: "222222", collateral: [], borrows: [] },
      { posId: "333333", collateral: [{ underlying: USDC, amount: BigInt(0) }, { underlying: USDC, amount: BigInt(5_000_000) }], borrows: [] },
    ],
    tokens,
  );
  assert.deepEqual(rows.map((r) => [r.ticker, r.qty, r.protocol_section, r.display_label]), [
    ["mETH", 1, "Deposit", "Position …111111"],
    ["USDC", -250, "Borrowed", "Position …111111"],
    ["USDC", 5, "Deposit", "Position …333333"],
  ]);
});

test("an underlying whose symbol/decimals couldn't be read is left out, never guessed", () => {
  assert.deepEqual(initHoldings("mnt", [{ posId: "1", collateral: [{ underlying: "0xunknown", amount: BigInt(1) }], borrows: [] }], tokens), []);
});
