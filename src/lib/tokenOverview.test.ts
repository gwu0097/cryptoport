import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTokenOverview, type TokenHoldingRow } from "./tokenOverview.ts";

const row = (o: Partial<TokenHoldingRow>): TokenHoldingRow => ({ ticker: "PYTH", qty: 100, usd_override: null, source: "auto", price_key: "pyth-network", protocol: null, walletId: "w1", walletName: "Phantom", chainName: "Solana", ...o });
const base = { key: "pyth-network", prices: { "pyth-network": 0.08 }, stats: null, contracts: [], watchlists: [], tradingView: "COINBASE:PYTHUSD", closes: [["2026-10-08", 0.08]] as [string, number][] };

test("every wallet holding the coin, valued, largest first, with the total", () => {
  const o = buildTokenOverview({ ...base, holdings: [row({}), row({ walletId: "w2", walletName: "Ledger", qty: 2000 })] });
  assert.deepEqual(o.position.rows.map((r) => [r.walletName, r.usd]), [["Ledger", 160], ["Phantom", 8]]);
  assert.equal(o.position.totalQty, 2100);
  assert.equal(o.position.totalUsd, 168);
  assert.equal(o.position.unpriced, 0);
});

test("unpriced rows are counted, never valued at 0; no rows means no total", () => {
  const o = buildTokenOverview({ ...base, prices: {}, holdings: [row({})] });
  assert.equal(o.position.totalUsd, null);
  assert.equal(o.position.unpriced, 1);
  assert.equal(o.position.rows[0].usd, null);
  const none = buildTokenOverview({ ...base, holdings: [] });
  assert.deepEqual([none.position.totalQty, none.position.totalUsd, none.ticker], [null, null, "pyth-network"]);
});

test("our closes are sent only when TradingView has no chart for it", () => {
  assert.deepEqual(buildTokenOverview({ ...base, holdings: [] }).chart, { tradingView: "COINBASE:PYTHUSD", closes: [] });
  assert.deepEqual(buildTokenOverview({ ...base, tradingView: null, holdings: [] }).chart.closes, [["2026-10-08", 0.08]]);
});
