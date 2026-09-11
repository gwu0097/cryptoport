import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const BASE_URL = "https://api.hyperliquid.xyz/info";
// Verified against real Hyperliquid balances (see commit message): only
// these three can be taken at exactly $1. Everything else on the spot
// account needs a real price or must be left unpriced — never guessed.
const STABLECOINS = new Set(["USDC", "USDT0", "USDE"]);
// Below this, don't bother creating a synthetic "perps" row at all.
const PERPS_DUST_FLOOR = 0.01;

interface ClearinghouseState {
  marginSummary: { accountValue: string };
  assetPositions: unknown[];
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
 * `marginSummary.accountValue`). Naively summing spot total + accountValue
 * double-counts that held USDC. The correct total is:
 *
 *   spot total (all coins, which already includes the held USDC)
 *   + (accountValue - the USDC hold amount)   // PnL/value not sourced from spot
 *
 * The second term is 0 when there are no open positions (accountValue ==
 * hold, as verified) and can be positive (unrealized profit) or negative
 * (unrealized loss) otherwise — it is NOT clamped to zero.
 */
export async function fetchHyperliquidHoldings(address: string): Promise<AdapterHolding[]> {
  const [perps, spot] = await Promise.all([
    postInfo<ClearinghouseState>({ type: "clearinghouseState", user: address }),
    postInfo<SpotClearinghouseState>({ type: "spotClearinghouseState", user: address }),
  ]);

  const holdings: AdapterHolding[] = [];
  const usdcBalance = spot.balances.find((b) => b.coin === "USDC");
  const usdcHold = usdcBalance ? Number(usdcBalance.hold) : 0;

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

  const accountValue = Number(perps.marginSummary.accountValue);
  const perpsExtra = accountValue - usdcHold;
  if (Number.isFinite(perpsExtra) && Math.abs(perpsExtra) > PERPS_DUST_FLOOR) {
    holdings.push({
      ticker: "HL-PERPS",
      qty: null,
      usd_override: perpsExtra,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: null,
    });
  }

  return holdings;
}
