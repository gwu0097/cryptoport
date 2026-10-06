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

test("closed rows count toward traders and the closed tally only", () => {
  const rows = [g("BTC", "a", "long", 100, 80_000, 1), { ...g("BTC", "b", "short", 50, 90_000, 1), closed: true }, { ...g("BTC", "c", "long", 10, 70_000, 1), closed: true }];
  const [btc] = groupByCoin(rows, (r) => r);
  assert.equal(btc.traders, 3);
  assert.equal(btc.closed, 2);
  assert.equal(btc.longs, 1);
  assert.equal(btc.shorts, 0);
  assert.equal(btc.notionalUsd, 100);
  assert.equal(btc.avgEntry, 80_000);
  const [onlyClosed] = groupByCoin([{ ...g("ETH", "a", "long", 5, 2000, 1), closed: true }], (r) => r);
  assert.equal(onlyClosed.avgEntry, null);
});

test("order \"rows\": coins follow the rows' order, each by its first row", () => {
  const rows = [g("BTC", "a", "long", 1, 1, 1), g("HYPE", "a", "long", 1, 1, 1), g("HYPE", "b", "long", 1, 1, 1), g("BTC", "c", "short", 1, 1, 1), g("HYPE", "c", "long", 1, 1, 1)];
  assert.deepEqual(groupByCoin(rows, (r) => r, "rows").map((x) => x.coin), ["BTC", "HYPE"]);
  assert.deepEqual(groupByCoin(rows, (r) => r).map((x) => x.coin), ["HYPE", "BTC"], "default: most traders first");
});
