import test from "node:test";
import assert from "node:assert/strict";
import { mergeSameCoin } from "./mergeHoldings.ts";
import type { Holding } from "./types.ts";

const h = (o: Partial<Holding>): Holding => ({ id: String(Math.random()), wallet_id: "w", ticker: "SPX", price_key: "spx6900", qty: 1, usd_override: null, source: "auto", contract: "0xspx", category: "token", chain: "eth", icon_url: null, ...o }) as Holding;

test("the same coin on the same chain becomes one row with the quantities added", () => {
  const out = mergeSameCoin([h({ qty: 10 }), h({ qty: 5 }), h({ ticker: "ETH", price_key: "ethereum", qty: 1, contract: null })]);
  assert.deepEqual(out.map((x) => [x.ticker, x.qty]), [["SPX", 15], ["ETH", 1]]);
});

test("other chains, positions and unpriced rows stay separate", () => {
  const out = mergeSameCoin([
    h({ qty: 10 }),
    h({ qty: 5, chain: "solana" }),
    h({ ticker: "LP", price_key: null, category: "defi", usd_override: 100 }),
    h({ ticker: "BTC-PERP", price_key: null, position_side: "long" }),
    h({ ticker: "X", price_key: null }),
    h({ ticker: "X", price_key: null }),
  ]);
  assert.equal(out.length, 6);
});

test("merging never changes the inputs", () => {
  const a = h({ qty: 10 });
  mergeSameCoin([a, h({ qty: 5 })]);
  assert.equal(a.qty, 10);
});
