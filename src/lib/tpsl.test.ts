import test from "node:test";
import assert from "node:assert/strict";
import { hyperliquidTpsl, jupiterTpsl, nearestTpsl, type HyperliquidOrder } from "./tpsl.ts";

const order = (over: Partial<HyperliquidOrder>): HyperliquidOrder => ({
  coin: "BTC",
  side: "A",
  sz: "0.05",
  triggerPx: "90000",
  isTrigger: true,
  isPositionTpsl: false,
  reduceOnly: true,
  orderType: "Take Profit Market",
  ...over,
});

test("Hyperliquid: reduce-only triggers on the closing side, by order type; whole-position size null", () => {
  const orders = [
    order({}),
    order({ orderType: "Stop Market", triggerPx: "80000", isPositionTpsl: true }),
    order({ orderType: "Take Profit Limit", triggerPx: "95000" }),
    order({ side: "B" }), // opens/adds, doesn't close a long
    order({ reduceOnly: false }), // an entry trigger
    order({ isTrigger: false }), // a plain limit
    order({ coin: "ETH" }),
  ];
  assert.deepEqual(hyperliquidTpsl(orders, "BTC", "long"), [
    { kind: "tp", price: 90000, size: 0.05 },
    { kind: "sl", price: 80000, size: null },
    { kind: "tp", price: 95000, size: 0.05 },
  ]);
  // Closing a short buys (B): only the reduce-only buy trigger counts for it.
  assert.deepEqual(hyperliquidTpsl(orders, "BTC", "short"), [{ kind: "tp", price: 90000, size: 0.05 }]);
});

test("Jupiter: tpslRequests in millionths of a dollar; entire position → size null", () => {
  assert.deepEqual(
    jupiterTpsl([
      { requestType: "tp", triggerPriceUsd: "75000000000", entirePosition: true },
      { requestType: "sl", triggerPriceUsd: "60000000000", entirePosition: false, sizeUsd: "6000000000" },
      { requestType: "tp", triggerPriceUsd: null, entirePosition: true },
    ]),
    [
      { kind: "tp", price: 75000, size: null },
      { kind: "sl", price: 60000, size: 0.1 },
    ],
  );
});

test("nearest: a long's lowest TP and highest SL; a short's reverse; the rest counted", () => {
  const orders = [
    { kind: "tp" as const, price: 95000, size: null },
    { kind: "tp" as const, price: 90000, size: 0.05 },
    { kind: "sl" as const, price: 80000, size: null },
  ];
  assert.deepEqual(nearestTpsl(orders, "long"), { tp: 90000, sl: 80000, more: 1 });
  assert.deepEqual(nearestTpsl(orders, "short"), { tp: 95000, sl: 80000, more: 1 });
  assert.deepEqual(nearestTpsl([], "long"), { tp: null, sl: null, more: 0 });
});
