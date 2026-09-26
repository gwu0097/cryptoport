import "server-only";
import { stablecoinFallbackUsd } from "../stablecoinFallback";
import { perpAccountRows, type PerpAccountState } from "../hyperliquidPerps";
import type { HyperliquidOrder } from "../tpsl";
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

type ClearinghouseState = PerpAccountState;

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

// HIP-3 markets and their collateral change rarely (a new market is a
// governance/stake event), so both are remembered per process for
// HIP3_TTL_MS. The market NAMES gate the account reads (one quick perpDexs
// call); each market's collateral (its meta's token index, named by
// spotMeta) is looked up alongside that market's account read, not before it
// — a cold start cost 0.86 s of serial lookups first (2026-09-26).
const HIP3_TTL_MS = 60 * 60_000;
let hip3NamesCache: { at: number; markets: { dex: string; label: string }[] } | null = null;
const collateralCache = new Map<string, { at: number; name: string }>();
let spotNamesCache: { at: number; names: Map<number, string> } | null = null;

async function hip3MarketNames(): Promise<{ dex: string; label: string }[]> {
  if (hip3NamesCache && Date.now() - hip3NamesCache.at < HIP3_TTL_MS) return hip3NamesCache.markets;
  const dexs = await postInfo<({ name: string; fullName?: string } | null)[]>({ type: "perpDexs" });
  const markets = dexs.filter((d): d is { name: string; fullName?: string } => !!d?.name).map((d) => ({ dex: d.name, label: d.fullName?.trim() || d.name }));
  hip3NamesCache = { at: Date.now(), markets };
  return markets;
}

async function spotTokenNames(): Promise<Map<number, string>> {
  if (spotNamesCache && Date.now() - spotNamesCache.at < HIP3_TTL_MS) return spotNamesCache.names;
  const meta = await postInfo<{ tokens: { index: number; name: string }[] }>({ type: "spotMeta" });
  spotNamesCache = { at: Date.now(), names: new Map(meta.tokens.map((t) => [t.index, t.name])) };
  return spotNamesCache.names;
}

async function hip3Collateral(dex: string): Promise<string> {
  const hit = collateralCache.get(dex);
  if (hit && Date.now() - hit.at < HIP3_TTL_MS) return hit.name;
  const [meta, names] = await Promise.all([postInfo<{ collateralToken?: number }>({ type: "meta", dex }), spotTokenNames()]);
  const name = names.get(meta.collateralToken ?? 0) ?? "USDC";
  collateralCache.set(dex, { at: Date.now(), name });
  return name;
}

/** Every HIP-3 market with its collateral (both cached, see above). */
export async function hip3Markets(): Promise<{ dex: string; label: string; collateral: string }[]> {
  const markets = await hip3MarketNames();
  return Promise.all(markets.map(async (m) => ({ ...m, collateral: await hip3Collateral(m.dex) })));
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
  const [perps, spot, vaultsResult, referralResult, hip3] = await Promise.all([
    postInfo<ClearinghouseState>({ type: "clearinghouseState", user: address }),
    postInfo<SpotClearinghouseState>({ type: "spotClearinghouseState", user: address }),
    // Optional extras: a failure is a warning and keeps their previous
    // rows (carryForward.ts). It used to be swallowed, dropping vault
    // equity from the wallet with no warning at all.
    postInfo<VaultEquity[]>({ type: "userVaultEquities", user: address }).catch((e: Error) => e),
    postInfo<ReferralState>({ type: "referral", user: address }).catch((e: Error) => e),
    // HIP-3 markets (builder-deployed perps, e.g. tradeXYZ): each is its own
    // account with its own margin, so money there isn't in the main account
    // (checked 2026-09-26: a trader's main + xyz + other markets matched
    // Hyperliquid's own perps total). One call per market; a market that
    // fails keeps its previous rows.
    hip3MarketNames()
      .then((markets) =>
        Promise.all(
          markets.map(async (named) => {
            // The account and the market's collateral, fetched together.
            const [state, collateral] = await Promise.all([
              postInfo<ClearinghouseState>({ type: "clearinghouseState", user: address, dex: named.dex }).catch((e: Error) => e),
              hip3Collateral(named.dex).catch((e: Error) => e),
            ]);
            if (collateral instanceof Error) return { m: { ...named, collateral: "USDC" }, state: collateral };
            return { m: { ...named, collateral }, state };
          }),
        ),
      )
      .catch((e: Error) => e),
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
  // A HIP-3 market's rows (kept when its read fails): its positions
  // ("xyz:TSLA-PERP") and its two cash rows ("XYZ · Withdrawable" /
  // "XYZ · Available", hyperliquidPerps.ts perpAccountRows). With no market
  // given, every HIP-3 market's rows.
  const isHip3CashLabel = (label: string | null | undefined, market?: string) =>
    !!label && (market === undefined ? / · (Withdrawable|Available)$/.test(label) : label === `${market} · Withdrawable` || label === `${market} · Available`);
  const hip3Scope = (m: { dex: string; label: string } | null): KeepScope => ({
    label: `hyperliquid ${m ? m.label : "HIP-3 markets"}`,
    owns: (h) => h.chain === "hyperliquid" && (m ? h.ticker.startsWith(`${m.dex}:`) || isHip3CashLabel(h.display_label, m.label) : /^[a-z0-9]+:/.test(h.ticker) || isHip3CashLabel(h.display_label)),
  });
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

  // Each market's account, then — only for markets with an open position —
  // its open orders for the positions' TP/SL (frontendOpenOrders, one call
  // per such market, all at once). A failed order read leaves TP/SL unknown;
  // it never fails the sync.
  const markets: { dex: string; label: string | null; collateral: string; state: ClearinghouseState }[] = [{ dex: "", label: null, collateral: "USDC", state: perps }];
  if (hip3 instanceof Error) {
    warnings.push(`hyperliquid HIP-3 markets: ${hip3.message}`);
    keep.push(hip3Scope(null));
  } else {
    for (const { m, state } of hip3) {
      if (state instanceof Error) {
        warnings.push(`hyperliquid ${m.label}: ${state.message}`);
        keep.push(hip3Scope(m));
        continue;
      }
      markets.push({ dex: m.dex, label: m.label, collateral: m.collateral, state });
    }
  }
  const hasPosition = (st: ClearinghouseState) => st.assetPositions.some(({ position }) => Number(position.szi) !== 0);
  const orders = await Promise.all(
    markets.map((mk) =>
      hasPosition(mk.state)
        ? postInfo<HyperliquidOrder[]>(mk.dex ? { type: "frontendOpenOrders", user: address, dex: mk.dex } : { type: "frontendOpenOrders", user: address }).catch(() => null)
        : Promise.resolve(null),
    ),
  );
  markets.forEach((mk, i) => {
    const rows = perpAccountRows(mk.state, mk.collateral, mk.label === null ? null : { label: mk.label }, orders[i]);
    for (const r of rows) if (r.usd_override === null) warnings.push(`hyperliquid ${mk.label ?? "main"}: ${mk.collateral} margin isn't a listed stablecoin — unpriced`);
    holdings.push(...rows);
  });

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
  // HIP-3 positions ("xyz:TSLA") are stocks/commodities, not coins:
  // CoinGecko has no logo for them, and the bare symbol would match an
  // unrelated token's. Not looked up.
  const isHip3 = (h: AdapterHolding) => /^[a-z0-9]+:/.test(h.ticker);
  const icons = await resolveTickerIcons(holdings.filter((h) => !isHip3(h)).map(iconTicker)).catch(() => new Map<string, string>());
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

/** Hyperliquid perps' MARK prices (what Hyperliquid computes unrealized PnL
 * with) and 24h change, keyed by perp name ("LIT", "kPEPE", "xyz:TSLA") —
 * one metaAndAssetCtxs call per market asked for: "" is the main market,
 * anything else a HIP-3 market ("xyz"). Used for open positions' live PnL
 * (perpPositions.ts). */
export async function fetchHyperliquidPerpMarks(markets: readonly string[] = [""]): Promise<Map<string, { usd: number; change24h: number | null }>> {
  const out = new Map<string, { usd: number; change24h: number | null }>();
  await Promise.all(
    [...new Set(markets)].map(async (dex) => {
      const [meta, ctxs] = await postInfo<[{ universe: { name: string }[] }, { markPx?: string; prevDayPx?: string }[]]>(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
      meta.universe.forEach((u, i) => {
        const usd = Number(ctxs[i]?.markPx);
        if (!Number.isFinite(usd) || usd <= 0) return;
        const prev = Number(ctxs[i]?.prevDayPx);
        out.set(u.name, { usd, change24h: Number.isFinite(prev) && prev > 0 ? ((usd - prev) / prev) * 100 : null });
      });
    }),
  );
  return out;
}
