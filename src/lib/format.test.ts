import test from "node:test";
import assert from "node:assert/strict";
import { formatPercent } from "./format.ts";

test("formatPercent adds an explicit + sign for a positive value", () => {
  assert.equal(formatPercent(1.8), "+1.80%");
});

test("formatPercent doesn't double a negative value's own sign", () => {
  assert.equal(formatPercent(-2.5), "-2.50%");
});

test("formatPercent shows a bare 0.00% for exactly zero, no sign", () => {
  assert.equal(formatPercent(0), "0.00%");
});

test("formatPercent accepts a numeric string, same as formatQty's convention", () => {
  assert.equal(formatPercent("3.333"), "+3.33%");
});

test("formatPercent returns — for null", () => {
  assert.equal(formatPercent(null), "—");
});
