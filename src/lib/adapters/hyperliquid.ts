import "server-only";
import { stablecoinFallbackUsd } from "../stablecoinFallback";
import { perpsUnallocatedUsd } from "../hyperliquidPerps";
import { fetchWithRetry } from "./http";
import { resolveTickerIcons } from "./coingecko";
import type { AdapterHolding } from "./types";
import type { KeepScope } from "../carryForward";

const BASE_URL = "https://api.hyperliquid.xyz/info";
// Consumed by zerionDefi.ts's NATIVELY_COVERED_PROTOCOLS (unioned across
// every dedicated-adapter file, not hand-maintained separately there) — see
// that constant's own doc comment for why this exists: Zerion must never
// write a row for a protocol this app already has its own bespoke adapter
// for, or a wallet's total silently double-counts the same real position.
// Best-guess at Zerion's own application_metadata.name for this protocol,
// largely moot in practice since Hyperliquid's own chain isn't in
// EVM_CHAINS (its positions already get dropped as an unrecognized chain
// before this check would even run) — kept anyway so that stays true by
// construction rather than by an incidental chain-mapping gap.
export const ZERION_PROTOCOL_NAMES = ["hyperliquid"];

interface HyperliquidPosition {
  coin: string;
  szi: string;
  entryPx: string;
  liquidationPx: string | null;
  unrealizedPnl: string;
  marginUsed: string;
  leverage: { type: string; value: number };
  // A fraction, not a percentage (live-verified: a real -0.0134 PnL on a
  // 4.97 margin position reported returnOnEquity -0.0026789, matching
  // -0.0134/4.967826 almost exactly) — ×100 at the call site below to match
  // Polymarket's percentPnl, which is already in percentage-point form.
  returnOnEquity: string;
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
export async function fetchHyperliquidHoldings(
  address: string,
): Promise<{ holdings: AdapterHolding[]; warnings: string[]; keep: KeepScope[] }> {
  const [perps, spot, vaultsResult, referralResult] = await Promise.all([
    postInfo<ClearinghouseState>({ type: "clearinghouseState", user: address }),
    postInfo<SpotClearinghouseState>({ type: "spotClearinghouseState", user: address }),
    // Optional extras: a failure is a warning and keeps their previous
    // rows (carryForward.ts). It used to be swallowed, dropping vault
    // equity from the wallet with no warning at all.
    postInfo<VaultEquity[]>({ type: "userVaultEquities", user: address }).catch((e: Error) => e),
    postInfo<ReferralState>({ type: "referral", user: address }).catch((e: Error) => e),
  ]);
  const warnings: string[] = [];
  const keep: KeepScope[] = [];
  const extra = <T,>(r: T | Error, section: string, what: string): T | null => {
    if (!(r instanceof Error)) return r;
    warnings.push(`hyperliquid ${what}: ${r.message}`);
    keep.push({ label: `hyperliquid ${what}`, owns: (h) => h.chain === "hyperliquid" && h.protocol_section === section });
    return null;
  };
  const vaults = extra(vaultsResult, "Yield", "vaults") ?? [];
  const referral = extra(referralResult, "Rewards", "referral rewards");

  const holdings: AdapterHolding[] = [];

  for (const balance of spot.balances) {
    const hold = Number(balance.hold) || 0;
    const free = Number(balance.total) - hold;
    if (!Number.isFinite(free) || free <= 0) continue;

    holdings.push({
      ticker: balance.coin,
      qty: free,
      // $1 fallback for listed stablecoins only (priced by their key first).
      usd_override: stablecoinFallbackUsd(balance.coin, free),
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
      usd_override: stablecoinFallbackUsd("USDC", withdrawable),
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

  // Only what isn't already withdrawable or a position's margin (each
  // position row below carries its own) — see hyperliquidPerps.ts.
  const available = perpsUnallocatedUsd(
    Number(perps.crossMarginSummary.accountValue),
    withdrawable,
    perps.assetPositions.filter(({ position }) => Number(position.szi) !== 0).map(({ position }) => Number(position.marginUsed)),
  );
  if (available !== null) {
    holdings.push({
      ticker: "USDC",
      qty: available,
      usd_override: stablecoinFallbackUsd("USDC", available),
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
    const roe = Number(position.returnOnEquity);
    const pnlPercent = Number.isFinite(roe) ? roe * 100 : null;

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
      position_pnl_percent: pnlPercent,
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
      usd_override: stablecoinFallbackUsd("USDC", unclaimed),
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

  // Icons filled in as a final pass rather than per-loop above — a perp
  // position's own ticker ("LINK-PERP") isn't a real symbol CoinGecko
  // knows, so the lookup key has to be the underlying coin, distinct from
  // the ticker actually stored/displayed. Best-effort, same as everywhere
  // else icons are resolved in this app: a failure here never drops real
  // balance data, holdings just render with their letter-avatar fallback.
  const iconTicker = (h: AdapterHolding) => (h.ticker.endsWith("-PERP") ? h.ticker.slice(0, -5) : h.ticker);
  const icons = await resolveTickerIcons(holdings.map(iconTicker)).catch(() => new Map<string, string>());
  for (const holding of holdings) {
    holding.icon_url = icons.get(iconTicker(holding).toUpperCase()) ?? null;
  }

  return { holdings, warnings, keep };
}

/** Every Hyperliquid spot token's USD price — the USDC pair's mark price
 * (the exchange's own reference price; several held tokens barely trade, and
 * the mid of a near-empty book is noise: WOW mid 0.00032 vs mark 0.00013 on
 * 2026-09-25) — and its 24h change from the previous day's price. One call.
 * Keyed by token name (PURR, HFUN, …). */
export async function fetchHyperliquidSpotPrices(): Promise<Map<string, { usd: number; change24h: number | null }>> {
  const [meta, ctxs] = await postInfo<
    [
      { tokens: { name: string; index: number }[]; universe: { tokens: [number, number]; index: number }[] },
      { markPx?: string; prevDayPx?: string }[],
    ]
  >({ type: "spotMetaAndAssetCtxs" });
  const nameByIndex = new Map(meta.tokens.map((t) => [t.index, t.name]));
  const out = new Map<string, { usd: number; change24h: number | null }>();
  for (const pair of meta.universe) {
    const [base, quote] = pair.tokens;
    if (nameByIndex.get(quote) !== "USDC") continue;
    const name = nameByIndex.get(base);
    const ctx = ctxs[pair.index];
    const usd = Number(ctx?.markPx);
    if (!name || !Number.isFinite(usd) || usd <= 0) continue;
    const prev = Number(ctx?.prevDayPx);
    out.set(name.toUpperCase(), { usd, change24h: Number.isFinite(prev) && prev > 0 ? ((usd - prev) / prev) * 100 : null });
  }
  return out;
}
