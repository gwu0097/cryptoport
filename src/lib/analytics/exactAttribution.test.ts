import test from "node:test";
import assert from "node:assert/strict";
import { exactChange, walletComposition, type WalletComposition } from "./exactAttribution.ts";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≉ ${b}`);
const comp = (assets: WalletComposition["assets"], positionsUsd = 0): WalletComposition => ({ assets, positionsUsd });

test("an untouched wallet: the whole change is price, nothing else (Ledger BTC - Biz)", () => {
  const c = exactChange(comp({ bitcoin: [1.5292, 84_293] }), comp({ bitcoin: [1.5292, 84_719] }));
  close(c.priceUsd, 1.5292 * 426);
  assert.equal(c.quantityUsd, 0);
  assert.equal(c.positionsUsd, 0);
});

test("bought more, sold out, bought new: quantity changes at the price they're valued at", () => {
  const c = exactChange(comp({ eth: [1, 2000], wif: [100, 2] }), comp({ eth: [2, 2100], pepe: [1e6, 0.00001] }));
  close(c.priceUsd, 100); // ETH 1 × +100
  close(c.quantityUsd, 2100 - 200 + 10); // +1 ETH at 2100, −100 WIF at 2, +1M PEPE
});

test("still held but no longer valued (turned illiquid) is a revaluation, never a sale", () => {
  const c = exactChange(comp({ stmatic: [17_058.6, 0.136] }), comp({ stmatic: [17_058.6, null] }));
  assert.equal(c.quantityUsd, 0);
  close(c.revaluedUsd, -17_058.6 * 0.136);
});

test("perp margin and positions are their own line", () => {
  const c = exactChange(comp({}, 3_700), comp({}, 3_500));
  assert.equal(c.positionsUsd, -200);
});

test("composition values rows exactly as the total does", () => {
  const prices = { bitcoin: 84_000, junk: 1 } as Record<string, number>;
  const comp = walletComposition(
    [
      { ticker: "BTC", qty: 1, usd_override: null, source: "auto", price_key: "bitcoin" },
      { ticker: "BTC", qty: 0.5, usd_override: null, source: "auto", price_key: "bitcoin" },
      { ticker: "LP", qty: 0, usd_override: 250, source: "auto", price_key: null },
      { ticker: "X", qty: 10, usd_override: null, source: "auto", price_key: "unpriced" },
    ],
    prices,
  );
  assert.deepEqual(comp.assets.bitcoin, [1.5, 84_000]);
  assert.deepEqual(comp.assets.unpriced, [10, null]);
  assert.equal(comp.positionsUsd, 250);
});
