import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTradingViewSymbol } from "./tradingViewPick.ts";

// The shape TradingView's symbol search returned for PYTH, 2026-10-09.
const pyth = [
  { source_id: "CRYPTOCAP", symbol: "PYTH", type: "index" },
  { source_id: "BINANCE", symbol: "PYTHUSDT.P", type: "swap" },
  { source_id: "KRAKEN", symbol: "PYTHUSD", type: "spot" },
  { source_id: "COINBASE", symbol: "PYTHUSD", type: "spot" },
  { source_id: "OKX", symbol: "PYTHUSDT", type: "spot" },
];

test("the biggest exchange with a spot pair wins; perps and indexes never", () => {
  assert.equal(pickTradingViewSymbol("PYTH", pyth), "COINBASE:PYTHUSD");
  assert.equal(pickTradingViewSymbol("pyth", [...pyth, { source_id: "BINANCE", symbol: "<em>PYTH</em>USDT", type: "spot" }]), "BINANCE:PYTHUSDT");
});

test("only an exact <TICKER><QUOTE> pair counts — not a coin whose ticker starts the same", () => {
  assert.equal(pickTradingViewSymbol("JUP", [{ source_id: "BINANCE", symbol: "JUPITERUSDT", type: "spot" }, { source_id: "BITSTAMP", symbol: "JUPUSD", type: "spot" }]), "BITSTAMP:JUPUSD");
  assert.equal(pickTradingViewSymbol("PYTH", [{ source_id: "BINANCE", symbol: "PYTHBTC", type: "spot" }]), null);
});

test("an exchange outside the list still beats nothing", () => {
  assert.equal(pickTradingViewSymbol("ABC", [{ source_id: "WHITEBIT", symbol: "ABCUSDT", type: "spot" }]), "WHITEBIT:ABCUSDT");
  assert.equal(pickTradingViewSymbol("NITEFEEDER", []), null);
});
