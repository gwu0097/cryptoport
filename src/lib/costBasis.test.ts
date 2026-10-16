import { test } from "node:test";
import assert from "node:assert/strict";
import { averageCost, historyMismatch, valuePaid, valueQtyPaid } from "./costBasis.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("buys average by what was paid; a sale leaves the average unchanged", () => {
  const r = averageCost([
    { at: "2026-10-01T00:00:00Z", qty: 10, paidUsd: 200 }, // $20
    { at: "2026-10-03T00:00:00Z", qty: 20, paidUsd: 500 }, // $25
    { at: "2026-10-05T00:00:00Z", qty: -15, paidUsd: null }, // sold half
  ]);
  assert.ok(close(r.avgCost!, 700 / 30));
  assert.ok(close(r.costedQty, 15));
  assert.ok(close(r.costUsd!, 350));
  assert.equal(r.buys, 2);
  assert.equal(r.firstBuyAt, "2026-10-01T00:00:00Z");
});

test("coins in without a visible payment are 'cost unknown', never free", () => {
  const r = averageCost([
    { at: "2026-10-01T00:00:00Z", qty: 10, paidUsd: 200 },
    { at: "2026-10-02T00:00:00Z", qty: 10, paidUsd: null }, // transfer in
    { at: "2026-10-04T00:00:00Z", qty: -10, paidUsd: null }, // half from each pool
  ]);
  assert.equal(r.avgCost, 20);
  assert.ok(close(r.costedQty, 5) && close(r.unknownQty, 5));
});

test("out of order input is sorted; nothing costed means no average", () => {
  const r = averageCost([
    { at: "2026-10-05T00:00:00Z", qty: -5, paidUsd: null },
    { at: "2026-10-01T00:00:00Z", qty: 10, paidUsd: 100 },
  ]);
  assert.equal(r.avgCost, 10);
  assert.equal(averageCost([{ at: "2026-10-01T00:00:00Z", qty: 4, paidUsd: null }]).avgCost, null);
  assert.deepEqual(averageCost([]), { avgCost: null, costUsd: null, costedQty: 0, unknownQty: 0, buys: 0, firstBuyAt: null });
});

test("a payment is valued when it was paid; an unpriced one makes the buy's cost unknown", () => {
  const B = BigInt;
  const priceOf = (c: string | null, at: string) => (c === null ? { usd: at.startsWith("2026-10-01") ? 2500 : 2600, decimals: 18 } : c === "0xusdc" ? { usd: 1, decimals: 6 } : null);
  const out = valuePaid(
    [
      { at: "2026-10-01T05:00:00Z", qty: 10, paid: [{ contract: null, raw: B("100000000000000000") }] }, // 0.1 ETH at $2,500
      { at: "2026-10-02T05:00:00Z", qty: 5, paid: [{ contract: "0xusdc", raw: B(125_000_000) }] }, // 125 USDC
      { at: "2026-10-03T05:00:00Z", qty: 5, paid: [{ contract: "0xmeme", raw: B(1) }] }, // no close: unknown
      { at: "2026-10-04T05:00:00Z", qty: 3, paid: [] }, // nothing paid: unknown
      { at: "2026-10-05T05:00:00Z", qty: -2, paid: [] },
    ],
    priceOf,
  );
  assert.deepEqual(out.map((e) => e.paidUsd), [250, 125, null, null, null]);
});

test("payments in units (Solana): SOL and USDC valued when paid; an unpriced coin makes the buy unknown", () => {
  const priceOf = (coin: string, at: string) => (coin === "coingecko:solana" ? (at.startsWith("2026-10-08") ? 200 : 210) : coin === "solana:USDC" ? 1 : null);
  const out = valueQtyPaid(
    [
      { at: "2026-10-08T18:03:00Z", qty: 766, paid: [{ coin: "coingecko:solana", qty: 2 }] },
      { at: "2026-10-06T15:31:00Z", qty: 1649, paid: [{ coin: "coingecko:solana", qty: 0.0015 }, { coin: "solana:USDC", qty: 500 }] },
      { at: "2026-10-09T00:00:00Z", qty: 10, paid: [{ coin: "solana:MEME", qty: 5 }] },
      { at: "2026-10-10T00:00:00Z", qty: -100, paid: [] },
    ],
    priceOf,
  );
  assert.deepEqual(out.map((e) => e.paidUsd), [400, 500.315, null, null]);
});

test("history vs synced holding: a sale since the last sync is named; agreement or unknown is not", () => {
  assert.equal(historyMismatch({ costedQty: 0, unknownQty: 0, holdingQty: 2015 }), 0); // PYTH: all sold, sync older
  assert.equal(historyMismatch({ costedQty: 100, unknownQty: 0.5, holdingQty: 100.5 }), null);
  assert.equal(historyMismatch({ costedQty: 100, unknownQty: 0, holdingQty: 100.9 }), null); // within 1%
  assert.equal(historyMismatch({ costedQty: 5, unknownQty: 0, holdingQty: null }), null);
});
