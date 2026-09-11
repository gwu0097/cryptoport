import test from "node:test";
import assert from "node:assert/strict";
import { blendedChange } from "./dashboard.ts";

test("blendedChange returns null when nothing has 24h data", () => {
  assert.equal(blendedChange([{ total: 100, change24h: null }]), null);
});

test("blendedChange returns null for an empty list", () => {
  assert.equal(blendedChange([]), null);
});

test("blendedChange weights by value, not a simple average", () => {
  // $900 up 10%, $100 down 10% — dollar-weighted result should be close to
  // +8%, not the naive average of 0%.
  const result = blendedChange([
    { total: 900, change24h: 10 },
    { total: 100, change24h: -10 },
  ]);
  assert.ok(result);
  assert.equal(result.usd, 900 * 0.1 + 100 * -0.1);
  assert.ok(Math.abs(result.pct - 8) < 0.001);
  assert.equal(result.coveragePct, 100);
});

test("blendedChange excludes unpriced/no-change groups from both the average and the coverage numerator", () => {
  const result = blendedChange([
    { total: 100, change24h: 10 },
    { total: 900, change24h: null },
  ]);
  assert.ok(result);
  assert.equal(result.pct, 10); // only the $100 group counts
  assert.equal(result.coveragePct, 10); // $100 of $1000 total
});

test("blendedChange with a single covered holding matches its own change exactly", () => {
  const result = blendedChange([{ total: 50, change24h: -25 }]);
  assert.ok(result);
  assert.equal(result.pct, -25);
  assert.equal(result.coveragePct, 100);
});
