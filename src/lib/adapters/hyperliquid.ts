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
  marginUsed: string;
  leverage: { type: string; value: number };
}

interface ClearinghouseState {
  crossMarginSummary: { accountValue: string };
  withdrawable: string;
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

interface VaultEquity {
  vaultAddress: string;
  equity: string;
}

interface ReferralState {
  unclaimedRewards: string;
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

function truncatedAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Best-effort only — a vault name is cosmetic (see display_label's own doc
// comment), never worth failing the whole sync over. Falls back to a
// truncated address, same "still usable, just less pretty" fallback
// TokenIcon uses for a missing/broken image.
async function fetchVaultName(vaultAddress: string): Promise<string> {
  try {
    const details = await postInfo<{ name?: string }>({ type: "vaultDetails", vaultAddress });
    return details.name || truncatedAddress(vaultAddress);
  } catch {
    return truncatedAddress(vaultAddress);
  }
}

/**
 * Hyperliquid's account is really four buckets DeBank's own UI already
 * separates (Deposit / Perpetuals / Yield / Rewards — matched here via
 * protocol_section) — this used to be flattened into "spot balances plus
 * one opaque perps total," silently dropping vault deposits and referral
 * rewards entirely and blending free spot cash with margin currently
 * committed to open positions into a single misleading "USDC" number.
 *
 * Deposit: a spot coin's `hold` is USDC pulled onto the perps side (margin),
 * not spot cash — so free spot USDC is `total - hold`, not `total` (every
 * other spot coin has hold=0 in practice, so this only changes USDC's own
 * row). Cross-margin USDC is split the same way Hyperliquid's own UI does:
 * `withdrawable` (immediately liquid) vs. the remainder of cross-margin
 * equity (allocated but not yet free to withdraw).
 *
 * Perpetuals: each open position is valued at its own margin committed —
 * matching both Hyperliquid's own UI and DeBank, "how much capital is
 * deployed" rather than "how much have I made or lost." Unrealized PnL is
 * real, signed money too, but shown only as an informational stat
 * (position_pnl_usd) rather than summed into the total: margin already
 * accounts for that capital being deployed, and the Deposit-side balances
 * above already correctly exclude it (via `hold`) — adding PnL on top would
 * still be additive and correct on its own, but would answer a different
 * question than the one this valuation is built to match.
 *
 * Yield / Rewards: vault equity and unclaimed referral rebates were never
 * fetched at all before — both real money DeBank already shows.
 */
export async function fetchHyperliquidHoldings(address: string): Promise<AdapterHolding[]> {
  const [perps, spot, vaults, referral] = await Promise.all([
    postInfo<ClearinghouseState>({ type: "clearinghouseState", user: address }),
    postInfo<SpotClearinghouseState>({ type: "spotClearinghouseState", user: address }),
    postInfo<VaultEquity[]>({ type: "userVaultEquities", user: address }).catch(() => []),
    postInfo<ReferralState>({ type: "referral", user: address }).catch(() => null),
  ]);

  const holdings: AdapterHolding[] = [];

  for (const balance of spot.balances) {
    const hold = Number(balance.hold) || 0;
    const free = Number(balance.total) - hold;
    if (!Number.isFinite(free) || free <= 0) continue;

    holdings.push({
      ticker: balance.coin,
      qty: free,
      usd_override: STABLECOINS.has(balance.coin) ? free : null,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null, // no icon source for Hyperliquid holdings
      protocol: "Hyperliquid",
      protocol_url: null, // no per-position deep link, unlike Jupiter's
      protocol_section: "Deposit",
    });
  }

  const withdrawable = Number(perps.withdrawable);
  if (Number.isFinite(withdrawable) && withdrawable > 0) {
    holdings.push({
      ticker: "USDC",
      qty: withdrawable,
      usd_override: withdrawable,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: null,
      protocol_section: "Deposit",
      display_label: "Perps Withdrawable",
    });
  }

  const crossEquity = Number(perps.crossMarginSummary.accountValue);
  const available = crossEquity - (Number.isFinite(withdrawable) ? withdrawable : 0);
  if (Number.isFinite(available) && available > 0) {
    holdings.push({
      ticker: "USDC",
      qty: available,
      usd_override: available,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: null,
      protocol_section: "Deposit",
      display_label: "Perps Available",
    });
  }

  for (const { position } of perps.assetPositions) {
    const size = Number(position.szi);
    if (!Number.isFinite(size) || size === 0) continue;
    const margin = Number(position.marginUsed);
    if (!Number.isFinite(margin)) continue;
    // Every open position is shown regardless of PnL size — the point is
    // visibility into what's open, not just ones currently moving; a
    // freshly-opened or perfectly flat position still has real leverage/
    // liquidation risk worth seeing.
    const pnl = Number.isFinite(Number(position.unrealizedPnl)) ? Number(position.unrealizedPnl) : 0;
    const liqPx = position.liquidationPx !== null ? Number(position.liquidationPx) : null;

    holdings.push({
      ticker: `${position.coin}-PERP`,
      qty: Math.abs(size),
      usd_override: margin,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: null,
      protocol_section: "Perpetuals",
      position_side: size > 0 ? "long" : "short",
      position_leverage: Number.isFinite(position.leverage?.value) ? position.leverage.value : null,
      position_entry_price: Number.isFinite(Number(position.entryPx)) ? Number(position.entryPx) : null,
      position_liquidation_price: liqPx !== null && Number.isFinite(liqPx) ? liqPx : null,
      position_pnl_usd: pnl,
    });
  }

  for (const v of vaults) {
    const equity = Number(v.equity);
    if (!Number.isFinite(equity) || equity <= 0) continue;
    const name = await fetchVaultName(v.vaultAddress);
    holdings.push({
      ticker: "USDC",
      qty: equity,
      usd_override: equity,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: `https://app.hyperliquid.xyz/vaults/${v.vaultAddress}`,
      protocol_section: "Yield",
      display_label: name,
    });
  }

  const unclaimed = referral ? Number(referral.unclaimedRewards) : NaN;
  if (Number.isFinite(unclaimed) && unclaimed > 0) {
    holdings.push({
      ticker: "USDC",
      qty: unclaimed,
      usd_override: unclaimed,
      contract: null,
      category: "defi",
      chain: "hyperliquid",
      icon_url: null,
      protocol: "Hyperliquid",
      protocol_url: null,
      protocol_section: "Rewards",
      display_label: "Referral Rewards",
    });
  }

  return holdings;
}
