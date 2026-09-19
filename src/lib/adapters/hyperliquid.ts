import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const BASE_URL = "https://api.hyperliquid.xyz/info";
// Verified against real Hyperliquid balances (see commit message): only
// these three can be taken at exactly $1. Everything else on the spot
// account needs a real price or must be left unpriced — never guessed.
const STABLECOINS = new Set(["USDC", "USDT0", "USDE"]);

interface HyperliquidPosition {
  coin: string;
  szi: string;
  entryPx: string;
  liquidationPx: string | null;
  unrealizedPnl: string;
  leverage: { type: string; value: number };
}

interface ClearinghouseState {
  marginSummary: { accountValue: string };
  assetPositions: { type: string; position: HyperliquidPosition }[];
}

interface SpotBalance {
  coin: string;
  total: string;
  hold: string;
}

interface SpotClearinghouseState {
  balances: SpotBalance[];
}

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithRetry(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${body.type} failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Hyperliquid's perps `accountValue` and spot USDC are not additive: perps
 * margin is USDC pulled from the spot balance and held there (verified —
 * for a real wallet, spot USDC's `hold` field was bit-for-bit identical to
 * `marginSummary.accountValue` when flat). A position's `marginUsed` is
 * already implicitly counted via that same spot USDC hold — so a position's
 * own usd_override is its unrealized PnL alone, never marginUsed or the
 * leveraged notional (`positionValue`), either of which would double-count
 * against spot USDC or overstate net worth by the leverage multiple. This
 * is the same math the old single "HL-PERPS" catch-all row used
 * (accountValue - usdcHold, which is 0 with no open positions and only
 * nonzero by exactly the sum of open positions' unrealized PnL) — now
 * broken out per position instead of collapsed into one row, so each open
 * position (side, leverage, entry/liquidation price) is actually visible
 * rather than folded into a single opaque number.
 */
export async function fetchHyperliquidHoldings(address: string): Promise<AdapterHolding[]> {
  const [perps, spot] = await Promise.all([
    postInfo<ClearinghouseState>({ type: "clearinghouseState", user: address }),
    postInfo<SpotClearinghouseState>({ type: "spotClearinghouseState", user: address }),
  ]);

  const holdings: AdapterHolding[] = [];

  for (const balance of spot.balances) {
    const total = Number(balance.total);
    if (!Number.isFinite(total) || total <= 0) continue;

    holdings.push({
      ticker: balance.coin,
      qty: total,
      usd_override: STABLECOINS.has(balance.coin) ? total : null,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null, // no icon source for Hyperliquid holdings
      protocol: "Hyperliquid",
      protocol_url: null, // no per-position deep link, unlike Jupiter's
    });
  }

  for (const { position } of perps.assetPositions) {
    const size = Number(position.szi);
    if (!Number.isFinite(size) || size === 0) continue;
    // Every open position is shown regardless of PnL size — the point is
    // visibility into what's open, not just ones currently moving; a
    // freshly-opened or perfectly flat position still has real leverage/
    // liquidation risk worth seeing.
    const pnl = Number.isFinite(Number(position.unrealizedPnl)) ? Number(position.unrealizedPnl) : 0;

    const liqPx = position.liquidationPx !== null ? Number(position.liquidationPx) : null;
    holdings.push({
      ticker: `${position.coin}-PERP`,
      qty: Math.abs(size),
      usd_override: pnl,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: null,
      position_side: size > 0 ? "long" : "short",
      position_leverage: Number.isFinite(position.leverage?.value) ? position.leverage.value : null,
      position_entry_price: Number.isFinite(Number(position.entryPx)) ? Number(position.entryPx) : null,
      position_liquidation_price: liqPx !== null && Number.isFinite(liqPx) ? liqPx : null,
      position_pnl_usd: pnl,
    });
  }

  return holdings;
}
