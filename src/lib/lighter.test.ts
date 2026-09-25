import test from "node:test";
import assert from "node:assert/strict";
import { lighterHoldings, poolSharePrice, positionMargin, type LighterAccount } from "./lighter.ts";

// The owner's real account, 2026-09-25: $600 USDC, no positions.
const OWNER: LighterAccount = {
  account_type: 0,
  index: 749858,
  available_balance: "600.000000",
  total_asset_value: "600",
  positions: [],
  assets: [{ symbol: "USDC", balance: "0.000000" }],
  shares: [],
};

test("a cash-only account is one USDC row at its available balance", () => {
  const rows = lighterHoldings([OWNER], new Map(), new Map());
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].ticker, rows[0].qty, rows[0].usd_override, rows[0].protocol_section], ["USDC", 600, 600, "Deposit"]);
});

test("positions carry their margin; the rows add up to the account value once", () => {
  const short = { symbol: "LIT", sign: -1, position: "423.28", avg_entry_price: "5.1787", position_value: "2010.622328", unrealized_pnl: "181.407847", liquidation_price: "24.64", initial_margin_fraction: "66.66", margin_mode: 0, allocated_margin: "0" };
  const long = { symbol: "ETH", sign: 1, position: "1", avg_entry_price: "2600", position_value: "2700", unrealized_pnl: "100", liquidation_price: "0", initial_margin_fraction: "5.00", margin_mode: 0, allocated_margin: "0" };
  const flat = { ...long, symbol: "BTC", position: "0" };
  const margins = positionMargin(short) + positionMargin(long); // 1340.28 + 135
  const acct: LighterAccount = { ...OWNER, available_balance: "1000", total_asset_value: String(1000 + margins + 50), positions: [short, long, flat] };
  const rows = lighterHoldings([acct], new Map(), new Map());
  const perps = rows.filter((r) => r.protocol_section === "Perpetuals");
  assert.deepEqual(perps.map((r) => r.ticker), ["LIT-PERP", "ETH-PERP"]); // zero-size BTC skipped
  assert.equal(perps[0].position_side, "short");
  assert.ok(Math.abs(perps[1].position_leverage! - 20) < 1e-9);
  assert.equal(perps[1].position_liquidation_price, null); // "0" = none, never $0
  const total = rows.reduce((s, r) => s + (r.usd_override ?? 0), 0);
  assert.ok(Math.abs(total - (1000 + margins + 50)) < 1e-6);
});

test("only the user's own accounts count; spot coins and pool shares are listed", () => {
  const operated: LighterAccount = { ...OWNER, account_type: 2, index: 99, available_balance: "50000", total_asset_value: "50000" };
  const withSpotAndShares: LighterAccount = {
    ...OWNER,
    assets: [{ symbol: "LIT", balance: "10" }],
    shares: [{ public_pool_index: 281474976710654, shares_amount: 1_000_000 }],
  };
  const pools = new Map([[281474976710654, { name: "Lighter Liquidity Provider (LLP)", usdPerShare: 0.0036 }]]);
  const rows = lighterHoldings([withSpotAndShares, operated], pools, new Map([["LIT", 5]]));
  assert.ok(!rows.some((r) => r.qty === 50000)); // the pool it operates isn't the user's money
  assert.deepEqual(rows.find((r) => r.ticker === "LIT")?.usd_override, 50);
  const pool = rows.find((r) => r.protocol_section === "Yield")!;
  assert.equal(pool.display_label, "Lighter Liquidity Provider (LLP)");
  assert.ok(Math.abs(pool.usd_override! - 3600) < 1e-9);
});

test("pool share price counts perps and spot value (LLP, live 2026-09-25)", () => {
  const p = poolSharePrice({ total_asset_value: "74428436.51969199", total_spot_value: "2429291.473868", total_shares: 21386291154 })!;
  assert.ok(Math.abs(p - 0.0035939) < 1e-6);
});
