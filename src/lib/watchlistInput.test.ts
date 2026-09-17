import test from "node:test";
import assert from "node:assert/strict";
import { parseTickerInput, pickBestMatch, MAX_BULK_TICKERS } from "./watchlistInput.ts";

test("parseTickerInput splits on commas", () => {
  assert.deepEqual(parseTickerInput("btc,eth,sol"), ["BTC", "ETH", "SOL"]);
});

test("parseTickerInput splits on newlines and mixed whitespace", () => {
  assert.deepEqual(parseTickerInput("btc\neth  sol\r\nada"), ["BTC", "ETH", "SOL", "ADA"]);
});

test("parseTickerInput strips a leading $", () => {
  assert.deepEqual(parseTickerInput("$BTC, $eth"), ["BTC", "ETH"]);
});

test("parseTickerInput dedupes, preserving first-seen order", () => {
  assert.deepEqual(parseTickerInput("BTC, eth, btc, ETH"), ["BTC", "ETH"]);
});

test("parseTickerInput drops empty tokens from stray separators", () => {
  assert.deepEqual(parseTickerInput("btc,, ,\n\neth"), ["BTC", "ETH"]);
});

test("parseTickerInput returns an empty list for blank input", () => {
  assert.deepEqual(parseTickerInput("   \n\n  "), []);
});

test("parseTickerInput caps at MAX_BULK_TICKERS", () => {
  const many = Array.from({ length: MAX_BULK_TICKERS + 20 }, (_, i) => `T${i}`).join(",");
  const result = parseTickerInput(many);
  assert.equal(result.length, MAX_BULK_TICKERS);
  assert.deepEqual(result, Array.from({ length: MAX_BULK_TICKERS }, (_, i) => `T${i}`));
});

test("pickBestMatch returns null for no results", () => {
  assert.equal(pickBestMatch("PEPE", []), null);
});

test("pickBestMatch prefers the lowest-rank exact symbol match over a higher-rank exact match", () => {
  const results = [
    { symbol: "PEPE", marketCapRank: 1039 },
    { symbol: "PEPE", marketCapRank: 56 },
    { symbol: "APEPE", marketCapRank: 149 },
  ];
  assert.deepEqual(pickBestMatch("pepe", results), { symbol: "PEPE", marketCapRank: 56 });
});

test("pickBestMatch never lets a non-exact-symbol result outrank an exact match", () => {
  const results = [
    { symbol: "SOLX", marketCapRank: 5 }, // higher relevance/lower rank, but wrong symbol
    { symbol: "SOL", marketCapRank: 400 },
  ];
  assert.deepEqual(pickBestMatch("SOL", results), { symbol: "SOL", marketCapRank: 400 });
});

test("pickBestMatch falls back to the top result when nothing matches the symbol exactly", () => {
  const results = [
    { symbol: "APEPE", marketCapRank: 149 },
    { symbol: "PEPECOIN", marketCapRank: 1039 },
  ];
  assert.deepEqual(pickBestMatch("XPEPE", results), { symbol: "APEPE", marketCapRank: 149 });
});

test("pickBestMatch treats a null rank as worse than any ranked result", () => {
  const results = [
    { symbol: "FOO", marketCapRank: null },
    { symbol: "FOO", marketCapRank: 900 },
  ];
  assert.deepEqual(pickBestMatch("FOO", results), { symbol: "FOO", marketCapRank: 900 });
});

test("pickBestMatch picks any candidate when every rank is null", () => {
  const results = [
    { symbol: "FOO", marketCapRank: null },
    { symbol: "FOO", marketCapRank: null },
  ];
  assert.deepEqual(pickBestMatch("FOO", results), { symbol: "FOO", marketCapRank: null });
});
