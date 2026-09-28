import test from "node:test";
import assert from "node:assert/strict";
import { appendLegs, contractFromKey, dayLines, toLegs, trimToBoundary, type ActivityLeg, type RawChange, type TxActivity } from "./watchActivity.ts";

const SOL = 120;
const known: Record<string, { assetKey: string; priceKey: string; ticker: string }> = {
  "solana|native": { assetKey: "solana", priceKey: "solana", ticker: "SOL" },
  "solana|gem": { assetKey: "jup:gem", priceKey: "jup:gem", ticker: "GEM" },
  "eth|native": { assetKey: "ethereum", priceKey: "ethereum", ticker: "ETH" },
  "arb|0xtok": { assetKey: "tok", priceKey: "tok", ticker: "TOK" },
};
const identify = (c: RawChange) => known[`${c.chain}|${c.contract ?? "native"}`] ?? null;
const valueOf = (k: string | null) => (k === "solana" ? SOL : k === "ethereum" ? 4000 : null);
const NO_NATIVE = new Set(["arb"]);
const chg = (txId: string, chain: string, contract: string | null, qty: number, at = "2026-09-28T10:00:00Z", counterparty: string | null = null): RawChange => ({ txId, at, chain, contract, symbol: null, qty, counterparty });

test("a swap: SOL out, gem in — the gem is priced by the SOL leg", () => {
  const legs = toLegs([chg("t1", "solana", null, -2.4), chg("t1", "solana", "gem", 1_000_000)], identify, valueOf, NO_NATIVE, "2026-09-28T12:00:00Z");
  const gem = legs.find((l) => l.ticker === "GEM")!;
  assert.equal(gem.kind, "swap");
  assert.ok(Math.abs(gem.priceUsd! - (2.4 * SOL) / 1_000_000) < 1e-12);
  assert.equal(legs.find((l) => l.ticker === "SOL")!.priceUsd, SOL);
});

test("spam and fees: an unknown token received is dropped; a lone SOL fee is dust", () => {
  const legs = toLegs([chg("t2", "solana", "spam", 5_000_000), chg("t3", "solana", null, -0.002)], identify, valueOf, NO_NATIVE, "x");
  assert.deepEqual(legs, []);
});

test("buying an unrecognized coin still counts the SOL as a swap leg, not a transfer out", () => {
  const legs = toLegs([chg("t4", "solana", null, -3), chg("t4", "solana", "unknown-mint", 42)], identify, valueOf, NO_NATIVE, "x");
  assert.equal(legs.length, 1);
  assert.equal(legs[0].kind, "swap");
});

test("a lone token out on a chain that can't show native legs is unclear, elsewhere a transfer", () => {
  assert.equal(toLegs([chg("t5", "arb", "0xtok", -10)], identify, valueOf, NO_NATIVE, "x")[0].kind, "unclear");
  assert.equal(toLegs([chg("t6", "solana", "gem", -10)], identify, valueOf, NO_NATIVE, "x")[0].kind, "transfer");
});

const leg = (over: Partial<ActivityLeg>): ActivityLeg => ({
  txId: "t",
  assetKey: "jup:gem",
  sourceChain: "solana",
  priceKey: "jup:gem",
  ticker: "GEM",
  qtyDelta: 0,
  kind: "swap",
  counterparty: null,
  priceUsd: 0.01,
  at: "2026-09-28T10:00:00Z",
  checkedAt: "2026-09-28T12:00:00Z",
  ...over,
});
const day = (legs: ActivityLeg[], base: TxActivity["base"] = {}): TxActivity => ({ boundary: "2026-09-28T08:00:00Z", legs, base });

test("two small adds are judged together against the morning quantity", () => {
  const base = { "jup:gem": { qty: 1_000_000, kept: false } }; // $10,000 at $0.01
  // Each +3% ($300) would pass on its own now (1%), so use +0.6% each: only together ≥ 1%.
  const one = [leg({ txId: "a", qtyDelta: 6_000 })];
  assert.deepEqual(dayLines([day(one, base)], new Set(), () => 0.01), []);
  const both = [leg({ txId: "a", qtyDelta: 6_000 }), leg({ txId: "b", qtyDelta: 6_000 })];
  const lines = dayLines([day(both, base)], new Set(), () => 0.01);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "added");
});

test("a new gem with no stored price is sized by its trade price", () => {
  const lines = dayLines([day([leg({ qtyDelta: 50_000, priceUsd: 0.01 })])], new Set(), () => null);
  assert.equal(lines[0].kind, "new");
  assert.equal(Math.round(lines[0].usdDelta), 500);
});

test("transfers between the influencer's own addresses cancel; a carried-forward coin is never sized", () => {
  const moved = [leg({ kind: "transfer", qtyDelta: -50_000, counterparty: "Other1", priceUsd: null })];
  assert.deepEqual(dayLines([day(moved, { "jup:gem": { qty: 60_000, kept: false } })], new Set(["other1"]), () => 0.01), []);
  const kept = [leg({ qtyDelta: 50_000 })];
  assert.deepEqual(dayLines([day(kept, { "jup:gem": { qty: 1, kept: true } })], new Set(), () => 0.01), []);
});

test("legs before the boundary never count; appending dedupes and a new read's boundary drops the old day", () => {
  const early = leg({ txId: "old", qtyDelta: 90_000, at: "2026-09-28T07:59:00Z" });
  assert.deepEqual(dayLines([day([early])], new Set(), () => 0.01), []);
  const first = appendLegs(null, "2026-09-28T08:00:00Z", [leg({ txId: "a", qtyDelta: 1 })], {});
  const again = appendLegs(first, "2026-09-28T08:00:00Z", [leg({ txId: "a", qtyDelta: 1 }), leg({ txId: "b", qtyDelta: 2 })], {});
  assert.deepEqual(again.legs.map((l) => l.txId), ["a", "b"]);
  const next = trimToBoundary(again, "2026-09-29T08:00:00Z");
  assert.deepEqual(next?.legs, []);
});

test("the copied contract is the token's own, never guessed", () => {
  assert.equal(contractFromKey("jup:HSUMi4rMgjrx7zRUabw3ogGu1pa5hmF2eVcXj9Apump"), "HSUMi4rMgjrx7zRUabw3ogGu1pa5hmF2eVcXj9Apump");
  assert.equal(contractFromKey("eth:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"), "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984");
  assert.equal(contractFromKey("hl:PURR"), null);
  assert.equal(contractFromKey("uniswap"), null);
  const line = dayLines([day([leg({ qtyDelta: 50_000, contract: "Mint111111111111111111111111111111" })])], new Set(), () => 0.01)[0];
  assert.equal(line.contract, "Mint111111111111111111111111111111");
  assert.equal(line.contractChain, "solana");
});
