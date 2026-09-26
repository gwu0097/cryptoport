import test from "node:test";
import assert from "node:assert/strict";
import { currentPnl, markKeyFor, totalPnl, withCurrentPnl, type PositionInput } from "./perpPositions.ts";

// BizNFT's LIT long as synced 2026-09-26 13:05 UTC.
const LIT: PositionInput = {
  chain: "hyperliquid",
  ticker: "LIT-PERP",
  qty: 1646,
  side: "long",
  entryPrice: 4.789295,
  marginUsd: 1578.8432,
  syncedPnlUsd: 11.0358,
  syncedPnlPercent: 0.7,
  syncedAt: "2026-09-26T13:05:48Z",
};

test("mark keys: Hyperliquid perps only, for now", () => {
  assert.equal(markKeyFor(LIT), "hlperp:LIT");
  assert.equal(markKeyFor({ chain: "solana-defi", ticker: "SOL-PERP" }), null);
  assert.equal(markKeyFor({ chain: "hyperliquid", ticker: "USDC" }), null);
});

test("a mark fetched after the sync gives live PnL: size × (mark − entry), return on margin", () => {
  const c = currentPnl(LIT, { usd: 4.9, at: "2026-09-26T14:00:00Z" });
  assert.equal(c.source, "mark");
  assert.ok(Math.abs(c.pnlUsd! - 1646 * (4.9 - 4.789295)) < 1e-9);
  assert.ok(Math.abs(c.pnlPercent! - (c.pnlUsd! / 1578.8432) * 100) < 1e-9);
  const short = currentPnl({ ...LIT, side: "short" }, { usd: 4.9, at: "2026-09-26T14:00:00Z" });
  assert.ok(Math.abs(short.pnlUsd! + c.pnlUsd!) < 1e-9);
});

test("the synced PnL stands when the sync is newer than the mark, or there's no mark", () => {
  assert.equal(currentPnl(LIT, { usd: 4.9, at: "2026-09-26T12:00:00Z" }).pnlUsd, 11.0358);
  assert.equal(currentPnl(LIT, undefined).source, "sync");
});

test("total: unknown PnL is left out and counted, never 0", () => {
  assert.deepEqual(totalPnl([{ pnlUsd: 11, pnlPercent: null, markPrice: null, source: "sync", asOf: null }, { pnlUsd: null, pnlPercent: null, markPrice: null, source: "sync", asOf: null }]), { usd: 11, unknown: 1 });
});

test("holding rows: an open position's PnL is replaced only by a newer mark; other rows pass through", () => {
  const row = { chain: "hyperliquid", ticker: "LIT-PERP", qty: "1646", usd_override: "1578.8432", position_side: "long" as const, position_entry_price: "4.789295", position_pnl_usd: "11.0358", position_pnl_percent: "0.7" };
  const marks = new Map([["hlperp:LIT", { usd: 4.9, at: "2026-09-26T14:00:00Z" }]]);
  const live = withCurrentPnl(row, "2026-09-26T13:05:48Z", marks);
  assert.ok(Math.abs(Number(live.position_pnl_usd) - 1646 * (4.9 - 4.789295)) < 1e-9);
  assert.equal(withCurrentPnl(row, "2026-09-26T15:00:00Z", marks), row); // synced after the mark
  const spot = { chain: "hyperliquid", ticker: "HYPE", qty: 1, usd_override: null };
  assert.equal(withCurrentPnl(spot, null, marks), spot);
});
