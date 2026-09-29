import test from "node:test";
import assert from "node:assert/strict";
import { chunkByLength, MAX_LIST_CHARS } from "./urlBatch.ts";

test("250 coin ids split so every batch's list stays within the limit", () => {
  const ids = Array.from({ length: 250 }, (_, i) => `some-coin-id-${i}`);
  const batches = chunkByLength(ids);
  assert.ok(batches.length > 1);
  for (const b of batches) assert.ok(b.join(",").length <= MAX_LIST_CHARS);
  assert.deepEqual(batches.flat(), ids);
});

test("contract addresses (42 characters) fit ~35 to a batch; the count cap still applies", () => {
  const addrs = Array.from({ length: 100 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
  const batches = chunkByLength(addrs);
  assert.ok(batches.every((b) => b.join(",").length <= MAX_LIST_CHARS));
  assert.equal(batches[0].length, 34);
  assert.ok(chunkByLength(["a", "b", "c"], 100, 2).every((b) => b.length <= 2));
});

test("an item longer than the limit goes alone; empty in, empty out", () => {
  assert.deepEqual(chunkByLength(["x".repeat(20), "y"], 10), [["x".repeat(20)], ["y"]]);
  assert.deepEqual(chunkByLength([]), []);
});
