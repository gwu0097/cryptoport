import test from "node:test";
import assert from "node:assert/strict";
import { groupByCoin, type GroupInput } from "./groups.ts";

const g = (coin: string, address: string, side: "long" | "short", notionalUsd: number, entryPx: number, size: number, directional = true): GroupInput => ({ coin, address, side, notionalUsd, entryPx, size, directional });

test("groups by coin, most traders first, keeping row order", () => {
  const rows = [g("BTC", "a", "long", 100, 80_000, 1), g("ETH", "a", "long", 50, 2_000, 1), g("ETH", "b", "long", 30, 2_600, 3, false), g("ETH", "c", "short", 10, 2_700, 1)];
  const groups = groupByCoin(rows, (r) => r);
  assert.deepEqual(groups.map((x) => x.coin), ["ETH", "BTC"]);
  const eth = groups[0];
  assert.equal(eth.traders, 3);
  assert.equal(eth.longs, 2);
  assert.equal(eth.shorts, 1);
  assert.equal(eth.directional, 2);
  assert.equal(eth.notionalUsd, 90);
  assert.equal(eth.avgEntry, null, "longs and shorts: no average");
  assert.deepEqual(eth.rows.map((r) => r.address), ["a", "b", "c"]);
});

test("one-sided group: size-weighted average entry; ties broken by size", () => {
  const groups = groupByCoin([g("SOL", "a", "long", 10, 100, 1), g("SOL", "b", "long", 10, 120, 3), g("AVAX", "a", "long", 5, 10, 1), g("AVAX", "b", "long", 50, 10, 1)], (r) => r);
  assert.deepEqual(groups.map((x) => x.coin), ["AVAX", "SOL"], "same trader count: bigger first");
  assert.equal(groups[1].avgEntry, (100 + 360) / 4);
});
