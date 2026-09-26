import test from "node:test";
import assert from "node:assert/strict";
import { packCandles, unpackCandles, toByteaHex, fromByteaHex } from "./candlePack.ts";

const candles = [
  { t: 1_790_000_000, o: 122.09, h: 123.5, l: 121.001, c: 122.14, n: 4_812 },
  { t: 1_790_003_600, o: 0.00001234, h: 0.0000125, l: 0.0000122, c: 0.0000124 }, // no trade count
];

test("candles round-trip exactly through the packed form and bytea hex", () => {
  const bytes = packCandles(candles);
  assert.equal(bytes.length, 2 * 48);
  assert.deepEqual(unpackCandles(fromByteaHex(toByteaHex(bytes))), candles);
});

test("an empty list packs to nothing; a truncated blob is refused", () => {
  assert.deepEqual(unpackCandles(packCandles([])), []);
  assert.throws(() => unpackCandles(new Uint8Array(47)));
});
