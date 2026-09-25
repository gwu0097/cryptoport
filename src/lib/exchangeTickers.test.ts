import test from "node:test";
import assert from "node:assert/strict";
import { mappingsFromTickers } from "./exchangeTickers.ts";

test("each base ticker maps to its coin; Kraken's XBT is stored as BTC", () => {
  const m = mappingsFromTickers("kraken", [
    { base: "XBT", coin_id: "bitcoin" },
    { base: "XDG", coin_id: "dogecoin" },
    { base: "XDG", coin_id: "dogecoin" }, // another pair of the same coin
    { base: "usdg", coin_id: "global-dollar" },
  ]);
  assert.deepEqual([...m].sort(), [["BTC", "bitcoin"], ["USDG", "global-dollar"], ["XDG", "dogecoin"]]);
});

test("a ticker naming two coins, or missing a coin id, is left out", () => {
  const m = mappingsFromTickers("mexc", [
    { base: "ABC", coin_id: "abc-one" },
    { base: "ABC", coin_id: "abc-two" },
    { base: "XYZ" },
    { base: "OK", coin_id: "ok" },
  ]);
  assert.deepEqual([...m], [["OK", "ok"]]);
});
