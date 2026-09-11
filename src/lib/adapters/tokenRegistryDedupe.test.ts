import test from "node:test";
import assert from "node:assert/strict";
import { dedupeTokenRegistryRows } from "./tokenRegistryDedupe.ts";

test("dedupeTokenRegistryRows keeps one row per (chain_id, contract)", () => {
  const rows = [
    { chain_id: "eth", contract: "0xabc", symbol: "AAA" },
    { chain_id: "eth", contract: "0xabc", symbol: "AAA-DUPLICATE" },
    { chain_id: "eth", contract: "0xdef", symbol: "BBB" },
  ];
  const deduped = dedupeTokenRegistryRows(rows);
  assert.equal(deduped.length, 2);
});

test("dedupeTokenRegistryRows keeps the last-seen row for a duplicate key (Map semantics)", () => {
  const rows = [
    { chain_id: "eth", contract: "0xabc", symbol: "FIRST" },
    { chain_id: "eth", contract: "0xabc", symbol: "SECOND" },
  ];
  const deduped = dedupeTokenRegistryRows(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].symbol, "SECOND");
});

test("dedupeTokenRegistryRows treats the same contract on different chains as distinct", () => {
  const rows = [
    { chain_id: "eth", contract: "0xabc", symbol: "AAA" },
    { chain_id: "base", contract: "0xabc", symbol: "AAA" },
  ];
  const deduped = dedupeTokenRegistryRows(rows);
  assert.equal(deduped.length, 2);
});

test("dedupeTokenRegistryRows leaves an already-unique list unchanged", () => {
  const rows = [
    { chain_id: "eth", contract: "0x1", symbol: "A" },
    { chain_id: "eth", contract: "0x2", symbol: "B" },
    { chain_id: "eth", contract: "0x3", symbol: "C" },
  ];
  assert.deepEqual(dedupeTokenRegistryRows(rows), rows);
});

test("dedupeTokenRegistryRows handles an empty list", () => {
  assert.deepEqual(dedupeTokenRegistryRows([]), []);
});
