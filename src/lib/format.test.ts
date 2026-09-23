import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPrice, formatPercent, formatUsdSigned, stripCitations } from "./format.ts";

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

test("formatUsdSigned adds an explicit + sign for a positive value", () => {
  assert.equal(formatUsdSigned(1234.5), "+$1,234.50");
});

test("formatUsdSigned lets Intl's own minus sign handle a negative value", () => {
  assert.equal(formatUsdSigned(-1234.5), "-$1,234.50");
});

test("formatUsdSigned shows a bare $0.00 for exactly zero, no sign", () => {
  assert.equal(formatUsdSigned(0), "$0.00");
});

test("stripCitations removes a single inline citation marker", () => {
  assert.equal(stripCitations("TVL rose 40% [web:23] over 30 days."), "TVL rose 40% over 30 days.");
});

test("stripCitations removes several back-to-back markers", () => {
  assert.equal(
    stripCitations("Confidential Intents surpassed $70M TVL[web:16][web:49]."),
    "Confidential Intents surpassed $70M TVL.",
  );
});

test("stripCitations doesn't leave a stray space before punctuation", () => {
  assert.equal(stripCitations("organic discussion [web:20], not bot-driven"), "organic discussion, not bot-driven");
});

test("stripCitations leaves text with no citation markers untouched", () => {
  assert.equal(stripCitations("No unlock cliff was found for this window."), "No unlock cliff was found for this window.");
});

test("formatPrice keeps sub-dollar precision and 2 decimals from $1 up", () => {
  assert.equal(formatPrice(97.2081), "$97.21");
  assert.equal(formatPrice(0.041234), "$0.04123");
  assert.equal(formatPrice(0.00001234), "$0.00001234");
});
