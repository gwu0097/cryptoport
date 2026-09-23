import test from "node:test";
import assert from "node:assert/strict";
import { diffUnmatched } from "./unmatched.ts";

const open = [
  { id: "1", kind: "no_fee_data", identifier: "a", reason: "r" },
  { id: "2", kind: "no_gecko_id", identifier: "b", reason: "old" },
  { id: "3", kind: "no_fee_data", identifier: "gone", reason: "r" },
];

test("an unchanged unmatched set writes nothing", () => {
  const d = diffUnmatched(open.slice(0, 1), [{ kind: "no_fee_data", identifier: "a", reason: "r" }]);
  assert.deepEqual(d, { toOpen: [], toResolveIds: [], reasonUpdates: [] });
});

test("opens new items, resolves vanished ones, updates changed reasons", () => {
  const d = diffUnmatched(open, [
    { kind: "no_fee_data", identifier: "a", reason: "r" },
    { kind: "no_gecko_id", identifier: "b", reason: "new" },
    { kind: "no_coingecko_market_data", identifier: "c", reason: "r" },
  ]);
  assert.deepEqual(d.toOpen.map((e) => e.identifier), ["c"]);
  assert.deepEqual(d.toResolveIds, ["3"]);
  assert.deepEqual(d.reasonUpdates, [{ id: "2", reason: "new" }]);
});

test("same identifier under a different kind is a separate interval", () => {
  const d = diffUnmatched(open.slice(0, 1), [{ kind: "no_gecko_id", identifier: "a", reason: "r" }]);
  assert.deepEqual(d.toResolveIds, ["1"]);
  assert.equal(d.toOpen.length, 1);
});

test("duplicate entries in one run collapse to one open row", () => {
  const e = { kind: "no_fee_data" as const, identifier: "x", reason: "r" };
  assert.equal(diffUnmatched([], [e, e]).toOpen.length, 1);
});

test("a degraded run leaves open rows of a kind it couldn't observe untouched, and opens none of that kind", () => {
  const withCg = [...open, { id: "9", kind: "no_coingecko_market_data", identifier: "delisted", reason: "r" }];
  const current = [
    { kind: "no_fee_data" as const, identifier: "a", reason: "r" },
    { kind: "no_gecko_id" as const, identifier: "b", reason: "old" },
    { kind: "no_fee_data" as const, identifier: "gone", reason: "r" },
    { kind: "no_coingecko_market_data" as const, identifier: "new-one", reason: "r" },
  ];
  const d = diffUnmatched(withCg, current, ["no_coingecko_market_data"]);
  assert.deepEqual(d.toResolveIds, [], "the open CoinGecko-kind row is not resolved");
  assert.deepEqual(d.toOpen, [], "no CoinGecko-kind row is opened");
});
