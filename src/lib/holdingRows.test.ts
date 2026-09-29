import test from "node:test";
import assert from "node:assert/strict";
import { toAssetRowGroups, toHoldingRows } from "./holdingRows.ts";
import type { AssetGroup, HoldingWithValuation } from "./queries.ts";

const holding = {
  id: "h1", wallet_id: "w1", ticker: "ETH", qty: 2, usd_override: null, source: "auto", contract: null, updated_at: "2026-09-29T00:00:00Z",
  category: null, chain: "eth", icon_url: "https://x/eth.png", protocol: null, protocol_url: null, coingecko_id: "ethereum", price_key: "ethereum",
  position_side: null, position_leverage: null, position_entry_price: null, position_liquidation_price: null, position_pnl_usd: null,
  position_pnl_percent: null, display_label: null, protocol_section: null, pool_contract: null, position_tpsl: null,
  valuation: { kind: "priced", usd: 5000 }, price: 2500, change24h: 1.5,
} as unknown as HoldingWithValuation;

test("a table row keeps what the table shows and drops the rest", () => {
  const [row] = toHoldingRows([holding]);
  assert.equal(row.qty, 2);
  assert.deepEqual(row.valuation, { kind: "priced", usd: 5000 });
  assert.equal(row.change24h, 1.5);
  assert.equal("wallet_id" in row, false);
  assert.equal("updated_at" in row, false);
  assert.equal("price_key" in row, false);
});

test("an asset group keeps its own fields; its holdings keep the expanded row's", () => {
  const group = { tickerKey: "ethereum", ticker: "ETH", total: 5000, holdings: [{ ...holding, walletId: "w1", walletName: "Main", chainId: "eth", chainName: "Ethereum" }] } as unknown as AssetGroup;
  const [g] = toAssetRowGroups([group]);
  assert.equal(g.total, 5000);
  assert.deepEqual(Object.keys(g.holdings[0]).sort(), ["chainName", "id", "protocol", "protocol_url", "qty", "ticker", "valuation", "walletId", "walletName"]);
});
