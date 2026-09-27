import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, normalizeWatchAddress, previousContracts, snapshotRowToAdapter, SNAPSHOT_MIN_USD } from "./watchSnapshot.ts";
import type { AdapterHolding } from "./adapters/types.ts";

type Row = AdapterHolding & { price_key: string | null };
const token = (ticker: string, contract: string, qty: number, price_key: string | null = ticker.toLowerCase()): Row => ({
  ticker,
  qty,
  usd_override: null,
  contract,
  category: "token",
  chain: "ethereum",
  icon_url: null,
  protocol: null,
  price_key,
});
const usdc = token("USDC", "0xA0B8", 10, "usd-coin");
// $1 per unit, unpriced when the key has no price.
const value = (prices: Record<string, number>) => (r: AdapterHolding & { price_key?: string | null }) => (r.price_key && r.price_key in prices ? (r.qty ?? 0) * prices[r.price_key] : null);

test("EVM addresses are lowercased; others kept as typed", () => {
  assert.equal(normalizeWatchAddress(" 0xAbCdEf0123456789aBcDeF0123456789AbCdEf01 "), "0xabcdef0123456789abcdef0123456789abcdef01");
  assert.equal(normalizeWatchAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
});

test("a snapshot drops null fields and marks carried-forward rows", () => {
  const snap = buildSnapshot([usdc], [{ ticker: "ETH", category: "token", chain: "base", qty: 1 }], [], value({ "usd-coin": 1 }));
  assert.deepEqual(snap.rows[0], { ticker: "USDC", qty: 10, contract: "0xA0B8", category: "token", chain: "ethereum", price_key: "usd-coin" });
  assert.equal(snap.rows[1].kept, true);
});

test("dust and spam never stored before are only counted", () => {
  const dust = token("DUST", "0xD057", 0.5, "dust");
  const unpriced = token("NEW", "0xNEW", 5, "new-coin");
  const position = { ...token("LP", "0xLP", 0, null), category: "defi" as const, usd_override: 0.2 };
  const spam = { chain: "ethereum", contract: "0xSPAM", symbol: "FREE", amount: 1e9 };
  const snap = buildSnapshot([usdc, dust, unpriced, position], [], [spam], value({ "usd-coin": 1, dust: 1 }));
  assert.deepEqual(snap.rows.map((r) => r.ticker), ["USDC", "LP"]);
  assert.equal(snap.dustCount, 2);
  assert.deepEqual(snap.unrecognized, []);
  assert.equal(snap.unrecognizedCount, 1);
  assert.ok(SNAPSHOT_MIN_USD > 0);
});

test("a stored token that is unpriced, dust or unrecognized today stays — a price gap is not a sale", () => {
  const before = buildSnapshot([usdc, token("PEPE", "0xPEPE", 1000, "pepe")], [], [], value({ "usd-coin": 1, pepe: 1 }));
  const after = buildSnapshot(
    [usdc, token("PEPE", "0xPEPE", 1000, "pepe")],
    [],
    [{ chain: "ethereum", contract: "0xa0b8", symbol: "USDC", amount: 10 }],
    value({}),
    before,
  );
  assert.deepEqual(after.rows.map((r) => r.ticker), ["USDC", "PEPE"]);
  assert.equal(after.unrecognized.length, 1);
});

test("previous contracts are last time's stored tokens, per chain", () => {
  const snap = buildSnapshot([usdc, { ...usdc, contract: null, ticker: "ETH", price_key: "ethereum" }], [], [], value({ "usd-coin": 1, ethereum: 1 }));
  assert.deepEqual([...previousContracts(snap)], [["ethereum", ["0xa0b8"]]]);
  assert.equal(previousContracts(null).size, 0);
});

test("a stored row round-trips to the adapter shape", () => {
  const [row] = buildSnapshot([usdc], [], [], value({ "usd-coin": 1 })).rows;
  const back = snapshotRowToAdapter({ ...row, kept: true });
  assert.equal(back.usd_override, null);
  assert.equal(back.icon_url, null);
  assert.equal(back.price_key, "usd-coin");
  assert.equal("kept" in back, false);
});
