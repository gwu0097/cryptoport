import "server-only";
import { cache } from "react";
import { serviceDb, userDb } from "./supabase";
import { getUser } from "./auth";
import {
  aggregate,
  parseNumeric,
  valueHolding,
  type PortfolioTotal,
  type PriceMap,
  type Valuation,
} from "./valuation";
import { pricesAsOf, type PricesAsOf } from "./pricesAsOf";
import { holdingKeyIndex, transactionPriceKey } from "./transactionPricing.ts";
import { chainDisplayName, defaultChainId } from "./chainNames";
import { formatTicker } from "./format";
import { pinnedWalletChain, externalPortfolioViewer, type WalletChain } from "./walletDisplay.ts";
import type { Holding, LinkedWallet, Tag, Transaction, Wallet, WalletWithTags } from "./types";

export type PriceRefreshPhaseStatus = "running" | "done" | "error";
export interface PriceRefreshPhase {
  status: PriceRefreshPhaseStatus;
  ms: number | null;
}
export type PriceRefreshPhases = Record<string, PriceRefreshPhase>;

export interface PriceRefreshState {
  refreshedAt: string | null;
  status: string | null;
  /** Compare-and-set claim timestamp for the current or most recent
   * refresh — see refreshPricesAction's own doc comment. Feeds
   * deriveJobStatus (lib/jobStatus.ts) the same way wallets.sync_started_at
   * does for a wallet sync. */
  startedAt: string | null;
  /** Per-lane ("coingecko" | "coinbase" | "evm" | "cosmos") live status/timing for the
   * current or most recent refresh — see prices.ts's refreshPrices, which
   * writes this incrementally as each lane finishes rather than only once
   * at the very end. Null before the very first refresh this app has ever
   * run. */
  phases: PriceRefreshPhases | null;
  /** When the user's held coins were priced (pricesAsOf.ts). */
  pricesAsOf: PricesAsOf;
}

/** The one global "prices last refreshed" timestamp — see
 * price_refresh_state in schema.sql for why this is a singleton row rather
 * than something stamped onto every wallet. Cached per-request via React's
 * cache() — same reasoning as every other function in this file that does,
 * see getPriceMap's doc comment. */
export const getPriceRefreshState = cache(async (): Promise<PriceRefreshState> => {
  const [{ data, error }, asOf] = await Promise.all([
    serviceDb().from("price_refresh_state").select("refreshed_at, status, started_at, phases").eq("id", 1).maybeSingle(),
    getHeldPricesAsOf().catch(() => ({ newestAt: null, stale: [] })),
  ]);
  if (error) throw new Error(`Failed to load price refresh state: ${error.message}`);
  return {
    refreshedAt: data?.refreshed_at ?? null,
    status: data?.status ?? null,
    startedAt: data?.started_at ?? null,
    phases: (data?.phases as PriceRefreshPhases | null) ?? null,
    pricesAsOf: asOf,
  };
});

/** When this user's held coins were priced (asset_prices.updated_at), per
 * pricesAsOf.ts: the bulk's time plus coins lagging it by over an hour. */
async function getHeldPricesAsOf(): Promise<PricesAsOf> {
  if (!(await getUser())) return { newestAt: null, stale: [] };
  const [wallets, stats] = await Promise.all([getActiveWalletsWithHoldings(), getAssetStatsMap()]);
  const held: { label: string; at: string | null }[] = [];
  for (const w of wallets) {
    for (const h of w.holdings) {
      const s = h.price_key ? stats.get(h.price_key) : undefined;
      if (s && s.usd !== null) held.push({ label: s.symbol ?? formatTicker(h.ticker), at: s.updatedAt });
    }
  }
  return pricesAsOf(held);
}

/** Every tag *this user* has ever created — populates TagPicker's dropdown
 * on the wallet add/edit forms and the wallets list's tag filter (see
 * resolveTagIds in wallets/actions.ts, which creates a tag the first time
 * its name is used). No explicit user filter here — RLS on cryptoport.tags
 * already scopes this to auth.uid(), see db/schema.sql. Cached per-request
 * via React's cache() — same reasoning as getPriceMap's doc comment. */
export const getTags = cache(async (): Promise<Tag[]> => {
  // Every page is viewable without a session (see (app)/layout.tsx) — but
  // anon has zero grants anywhere in the cryptoport schema (db/schema.sql),
  // not even schema usage, so userDb() with no session would fail with a
  // hard "permission denied" error, not an empty RLS-filtered result.
  // Short-circuit before ever touching Postgres; every userDb()-based
  // function in this file does the same for the same reason.
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data, error } = await db.from("tags").select("id, name").order("name");
  if (error) throw new Error(`Failed to load tags: ${error.message}`);
  return data as Tag[];
});

/** Every wallet *this user* has verified sign-in access with (see
 * walletAuth.ts) — for the Settings "Linked wallets" panel. No explicit
 * user filter, same reasoning as getTags(): RLS already scopes this.
 * Cached per-request — getWalletsWithTotals and the Settings page both
 * call this independently in the same render. */
export const getLinkedWallets = cache(async (): Promise<LinkedWallet[]> => {
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data, error } = await db
    .from("linked_wallets")
    .select("id, chain, address, verified_at")
    .order("verified_at", { ascending: true });
  if (error) throw new Error(`Failed to load linked wallets: ${error.message}`);
  return data as LinkedWallet[];
});

/** Whether *this user* has already verified this exact address — RLS scopes
 * the read to auth.uid(), so a hit here specifically means "linked to me,"
 * never just "linked to someone." Used by the wallet detail page's "Link
 * this wallet" affordance to show a checkmark instead of the button once
 * already done. Same case-sensitivity split as the dedupe logic in
 * (auth)/walletActions.ts and (app)/settings/walletActions.ts. */
export async function isWalletLinked(chain: "ETH" | "SOL", address: string): Promise<boolean> {
  if (!(await getUser())) return false;
  const db = await userDb();
  const base = db.from("linked_wallets").select("id").eq("chain", chain);
  const query = chain === "ETH" ? base.ilike("address", address) : base.eq("address", address);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(`Failed to check linked wallets: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

// Exchange "chains" aren't CoinGecko asset_platforms and have no single
// native coin to borrow an icon from (see NATIVE_ICON_CHAINS's doc comment
// in coingeckoIds.ts), so refreshTokenRegistry structurally can never
// populate a chain_icons row for them — a small hardcoded fallback instead
// of asking the user to run one-off SQL for a single static logo. CoinGecko
// itself tracks Coinbase as an exchange (id "gdax") with this exact image.
const STATIC_CHAIN_ICONS: Record<string, string> = {
  coinbase: "https://coin-images.coingecko.com/markets/images/23/small/Coinbase_Coin_Primary.png?1706864258",
  // Polymarket is an app on Polygon, not its own CoinGecko asset_platform —
  // same "no chain-icon sync mechanism could ever cover it" reasoning as
  // Coinbase above. CoinGecko does track Polymarket's own governance/points
  // token, whose logo doubles as the brand mark here.
  polymarket: "https://coin-images.coingecko.com/coins/images/70290/large/poly.png",
  // Same "CEX, not a chain, so no asset_platform" reasoning as Coinbase —
  // CoinGecko also tracks Kraken/Gemini/MEXC as exchanges with their own
  // logos. CoinGecko's own exchange id for MEXC is "mxc" (a legacy
  // rebrand artifact, live-verified via /exchanges/list — MEXC used to be
  // named MXC), not "mexc"; this app's own chain id stays "mexc" to match
  // wallets.provider/exchange_connections.provider, only the CoinGecko
  // lookup itself needed the older id.
  kraken: "https://coin-images.coingecko.com/markets/images/29/small/kraken.jpg?1706864265",
  gemini: "https://coin-images.coingecko.com/markets/images/50/small/gemini.png?1706864273",
  mexc: "https://coin-images.coingecko.com/markets/images/409/small/164286be-32a5-4b58-978c-d072eea00eb9.jpeg?1775619316",
};

/** chain id (evmChains.ts id, or 'solana' | 'hyperliquid') -> logo URL —
 * see coingecko.ts's refreshTokenRegistry for how this is kept populated.
 * Shared/global, not per-user — serviceDb() is correct here. Cached
 * per-request — same reasoning as getPriceMap's doc comment. */
export const getChainIconMap = cache(async (): Promise<Record<string, string>> => {
  const { data, error } = await serviceDb().from("chain_icons").select("chain_id, image_url");
  if (error) throw new Error(`Failed to load chain_icons: ${error.message}`);

  const icons: Record<string, string> = { ...STATIC_CHAIN_ICONS };
  for (const row of data as { chain_id: string; image_url: string }[]) {
    icons[row.chain_id] = row.image_url;
  }
  return icons;
});

// Shared/global, not per-user — every user's holdings draw from the same
// ticker-keyed price cache, see prices.ts's refreshPrices doc comment.
// Cached per-request via React's cache(): several of this file's own
// grouped queries (getWalletsWithTotals, getAssetsGroupedByChain,
// getAssetsGroupedByTicker, getDefiGroupedByProtocol) each call this
// independently, and a page can render more than one of those in the same
// request (the Dashboard used to, calling this twice for identical data
// before that page was simplified) — cache() means that's now a
// structural non-issue rather than something that happens to not be a
// problem today.
/** The one price per asset (asset_prices), keyed by price_key — what every
 * holding is valued from (valuation.ts, docs/pricing/PLAN.md). */
export const getPriceMap = cache(async (): Promise<PriceMap> => {
  const prices: PriceMap = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await serviceDb().from("asset_prices").select("price_key, usd").order("price_key").range(from, from + 999);
    if (error) throw new Error(`Failed to load asset prices: ${error.message}`);
    for (const row of data as { price_key: string; usd: number | string | null }[]) prices[row.price_key] = row.usd;
    if (data.length < 1000) return prices;
  }
});

export interface AssetStats {
  usd: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  marketCap: number | null;
  updatedAt: string | null;
  source: string | null;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
}

/** price_key -> the asset's one price, its 1h/24h/7d/30d change, market cap
 * and display info (asset_prices + assets) — what every asset row shows
 * (docs/pricing/PLAN.md). Cached per request. */
export const getAssetStatsMap = cache(async (): Promise<Map<string, AssetStats>> => {
  const out = new Map<string, AssetStats>();
  const num = (v: unknown) => parseNumeric(v as number | string | null);
  for (let from = 0; ; from += 1000) {
    const { data, error } = await serviceDb()
      .from("asset_prices")
      .select("price_key, usd, change_1h, change_24h, change_7d, change_30d, market_cap, updated_at, source")
      .order("price_key")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to load asset prices: ${error.message}`);
    for (const r of data as Record<string, unknown>[]) {
      out.set(r.price_key as string, {
        usd: num(r.usd),
        change1h: num(r.change_1h),
        change24h: num(r.change_24h),
        change7d: num(r.change_7d),
        change30d: num(r.change_30d),
        marketCap: num(r.market_cap),
        updatedAt: (r.updated_at as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        symbol: null,
        name: null,
        imageUrl: null,
      });
    }
    if (data.length < 1000) break;
  }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await serviceDb().from("assets").select("price_key, symbol, name, image_url").order("price_key").range(from, from + 999);
    if (error) throw new Error(`Failed to load assets: ${error.message}`);
    for (const r of data as { price_key: string; symbol: string | null; name: string | null; image_url: string | null }[]) {
      const s = out.get(r.price_key);
      if (s) Object.assign(s, { symbol: r.symbol, name: r.name, imageUrl: r.image_url });
    }
    if (data.length < 1000) break;
  }
  return out;
});

// The ticker-keyed `prices` table is deliberately never consulted for a
// holding that already carries usd_override (see valuation.ts) — but the
// per-unit "Price" column still wants a number to show instead of a
// misleading "unpriced" on a row that clearly has a value. Derived only for
// display; never fed back into valuation.
/** Per-unit price: the asset's one price when it has one, else the stored
 * value per unit (a position, or a sync-time value awaiting pricing). */
function effectivePrice(holding: Pick<Holding, "usd_override" | "qty" | "price_key">, prices: PriceMap): number | null {
  const assetPrice = holding.price_key ? parseNumeric(prices[holding.price_key]) : null;
  if (assetPrice !== null) return assetPrice;
  const override = parseNumeric(holding.usd_override);
  const qty = parseNumeric(holding.qty);
  if (override !== null && qty !== null && qty !== 0) return override / qty;
  return null;
}

/** A holding's 24h change: its asset's (asset_prices), or null when it has
 * no asset (a position, an unmapped token) — never another coin's by ticker. */
function keyChange24h(holding: Pick<Holding, "price_key">, assetStats: ReadonlyMap<string, AssetStats>): number | null {
  return holding.price_key ? (assetStats.get(holding.price_key)?.change24h ?? null) : null;
}

export interface WalletWithTotal extends WalletWithTags {
  total: number;
  unpricedCount: number;
  /** Whether this wallet's (chain, address) has been verified (see
   * linked_wallets) by the signed-in user — same check as the wallet detail
   * page's isWalletLinked, computed once here against a single
   * getLinkedWallets() call instead of one query per row. */
  verified: boolean;
  /** Computed here (server-side, via walletDisplay.ts's pinnedWalletChain)
   * rather than in WalletsTable.tsx itself, so "does this wallet get a
   * Verify affordance at all" is answered identically here and on the
   * wallet detail page — one shared implementation, not two copies of the
   * same chain-to-scheme mapping. null means this chain has no wallet-auth
   * signature scheme at all (BTC, ADA, ...) — never show a Verify
   * affordance for it. */
  pinnedChain: WalletChain | null;
  /** Computed here the same way (walletDisplay.ts's externalPortfolioViewer,
   * which already excludes a BTC xpub/ypub/zpub itself) so the wallets list
   * gets the identical jup.ag/DeBank/UniSat link the wallet detail page and
   * /lookup already have — a quick place to cross-check a wallet's actual
   * on-chain state next to its name. Null when the chain has no free
   * external viewer or there's no address to look up at all. */
  externalViewer: { url: string; label: string } | null;
}

export interface WalletListResult {
  wallets: WalletWithTotal[];
  grand: PortfolioTotal;
}

/** Wallets list, each with its own total, plus a grand total across all of them. */
/**
 * `opts.userId` — the admin-only read path (src/app/(app)/admin/), never
 * passed from a normal page. Swaps userDb()'s implicit, session-scoped RLS
 * for serviceDb() + an explicit .eq("user_id", ...) filter — same
 * "serviceDb() + explicit user_id, session-independent" shape
 * captureUserSnapshot (snapshots.ts) already established, rather than a
 * second copy of this whole function that could quietly drift from this
 * one. Linked-wallet verification badges are skipped for the admin path
 * (linkedWallets stays []) — getLinkedWallets() is itself session-scoped,
 * and "is this wallet's signature verified" isn't essential to a read-only
 * peek at someone else's portfolio.
 */
/** Cheapest possible "does this account have at least one wallet" check —
 * used right after sign-in to decide whether to land on Dashboard (there's
 * already something to show) or Wallets (nothing tracked yet, so Wallets'
 * own add-a-wallet CTA is more useful than an empty Dashboard). A plain
 * count-only existence check, not getWalletsWithTotals — that joins
 * holdings/tags and computes grand totals, all wasted work just to answer
 * "any at all?". */
export async function hasAnyWallet(): Promise<boolean> {
  const db = await userDb();
  const { count, error } = await db.from("wallets").select("id", { count: "exact", head: true }).eq("active", true);
  if (error) throw new Error(`Failed to check wallets: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function getWalletsWithTotals(opts?: { userId: string }): Promise<WalletListResult> {
  if (!opts && !(await getUser())) return { wallets: [], grand: aggregate([], {}) };
  const db = opts ? serviceDb() : await userDb();
  const baseQuery = db.from("wallets").select("*, holdings(*), tags(id,name)").eq("active", true);
  const walletsQuery = (opts ? baseQuery.eq("user_id", opts.userId) : baseQuery).order("created_at", {
    ascending: true,
  });
  const [{ data: wallets, error: walletsError }, prices, linkedWallets] = await Promise.all([
    walletsQuery,
    getPriceMap(),
    opts ? Promise.resolve<LinkedWallet[]>([]) : getLinkedWallets(),
  ]);
  if (walletsError) throw new Error(`Failed to load wallets: ${walletsError.message}`);

  type WalletRow = WalletWithTags & { holdings: Holding[] };
  const rows = wallets as WalletRow[];

  // ETH is stored lowercased in linked_wallets (see normalizeAddress) but a
  // tracked wallet's own address is whatever the user typed — lowercase
  // both sides of the key for ETH, keep SOL's case-sensitive base58 as-is.
  const linkedKeys = new Set(
    linkedWallets.map((l) => `${l.chain}:${l.chain === "ETH" ? l.address.toLowerCase() : l.address}`),
  );

  const walletsWithTotals = rows.map((wallet) => {
    const { holdings, ...rest } = wallet;
    const { total, unpricedCount } = aggregate(holdings, prices);
    const pinnedChain = wallet.address ? pinnedWalletChain(wallet.chain) : null;
    const verified =
      !!pinnedChain &&
      !!wallet.address &&
      linkedKeys.has(`${pinnedChain}:${pinnedChain === "ETH" ? wallet.address.toLowerCase() : wallet.address}`);
    const externalViewer = wallet.address ? externalPortfolioViewer(wallet.chain, wallet.address) : null;
    return { ...rest, total, unpricedCount, verified, pinnedChain, externalViewer };
  });

  const allHoldings = rows.flatMap((wallet) => wallet.holdings);
  const grand = aggregate(allHoldings, prices);

  return { wallets: walletsWithTotals, grand };
}

export interface HoldingWithValuation extends Holding {
  valuation: Valuation;
  /** Raw per-unit ticker price, for display only — manual_usd holdings have no per-unit price. */
  price: number | null;
  /** Same contract-then-ticker resolution as getAssetsGroupedByTicker's own
   * per-holding change24h (see that function's doc comment on why
   * contract-keyed stats take priority — EVM holdings are valued via
   * usd_override and never touch the ticker-keyed `prices` table, so only
   * token_registry's stats exist for them). Null, not 0, when neither
   * source has it — reported directly: Portfolio/Wallet's mobile view
   * showed no 24h at all, unlike Assets/Watchlist. */
  change24h: number | null;
}

export interface ChainGroup {
  chainId: string;
  chainName: string;
  total: number;
  unpricedCount: number;
  holdings: HoldingWithValuation[];
}

// A holding's own `chain` (set by auto adapters — one 'ETH' wallet spans
// many EVM chains) wins; `fallbackChain` (the wallet's chain) covers manual
// holdings and pre-chain-column sync rows. Sorted richest-first, matching
// how Rabby/DeBank order theirs.
// Priced holdings first (richest first), unpriced last — can't rank what
// has no known value, and dumping it at the top would bury what actually
// matters.
function byValueDesc(a: HoldingWithValuation, b: HoldingWithValuation): number {
  const av = a.valuation.kind === "priced" ? a.valuation.usd : -Infinity;
  const bv = b.valuation.kind === "priced" ? b.valuation.usd : -Infinity;
  return bv - av;
}

function groupByChain(
  entries: { holding: HoldingWithValuation; fallbackChain: string }[],
  prices: PriceMap,
): ChainGroup[] {
  const byChain = new Map<string, HoldingWithValuation[]>();
  for (const { holding, fallbackChain } of entries) {
    const chainId = holding.chain ?? fallbackChain;
    const list = byChain.get(chainId);
    if (list) list.push(holding);
    else byChain.set(chainId, [holding]);
  }

  return [...byChain.entries()]
    .map(([chainId, holdings]) => {
      const { total, unpricedCount } = aggregate(holdings, prices);
      return {
        chainId,
        chainName: chainDisplayName(chainId),
        total,
        unpricedCount,
        holdings: [...holdings].sort(byValueDesc),
      };
    })
    .sort((a, b) => b.total - a.total);
}

export interface ValuatedHoldings {
  holdings: HoldingWithValuation[];
  chainGroups: ChainGroup[];
  total: number;
  unpricedCount: number;
}

/** Shared by every "one entity, many chains" view — a saved wallet
 * (getWalletDetail) and an ad-hoc, unsaved address lookup (lib/lookup.ts)
 * alike. `fallbackChain` covers holdings with no `chain` of their own
 * (manual rows, or pre-chain-column sync rows). `assetStats` is optional
 * (an address lookup shows no 24h change). */
export function valuateHoldings(
  holdings: Holding[],
  fallbackChain: string,
  prices: PriceMap,
  assetStats: ReadonlyMap<string, AssetStats> = new Map(),
): ValuatedHoldings {
  const holdingsWithValuation: HoldingWithValuation[] = holdings.map((holding) => ({
    ...holding,
    valuation: valueHolding(holding, prices),
    price: effectivePrice(holding, prices),
    change24h: keyChange24h(holding, assetStats),
  }));
  const chainGroups = groupByChain(
    holdingsWithValuation.map((holding) => ({ holding, fallbackChain })),
    prices,
  );
  const { total, unpricedCount } = aggregate(holdings, prices);

  return { holdings: holdingsWithValuation, chainGroups, total, unpricedCount };
}

export interface WalletDetailResult extends ValuatedHoldings {
  wallet: WalletWithTags;
}

/** `opts.userId` — same admin-only read path as getWalletsWithTotals' own
 * `opts` param (see that function's doc comment); serviceDb() + an
 * explicit user_id filter instead of userDb()'s implicit session-scoped
 * RLS, never passed from a normal page. Filtering on both `id` and
 * `opts.userId` together (not just `id`) means an admin route can never
 * be tricked into returning a wallet outside the target user it already
 * resolved via getAdminTargetUser — same as looking up "this wallet,
 * belonging to this user" rather than "this wallet, whoever owns it". */
export async function getWalletDetail(id: string, opts?: { userId: string }): Promise<WalletDetailResult | null> {
  // Belt and suspenders — wallets/[id]/page.tsx checks getUser() itself and
  // redirects a guest to /login before ever calling this, but this stays
  // guarded too rather than relying solely on the caller to do it first.
  if (!opts && !(await getUser())) return null;
  const db = opts ? serviceDb() : await userDb();
  const baseQuery = db.from("wallets").select("*, holdings(*), tags(id,name)").eq("id", id);
  const [{ data: wallet, error: walletError }, prices, assetStats] = await Promise.all([
    (opts ? baseQuery.eq("user_id", opts.userId) : baseQuery).maybeSingle(),
    getPriceMap(),
    getAssetStatsMap(),
  ]);
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet) return null;

  const { holdings, ...rest } = wallet as WalletWithTags & { holdings: Holding[] };
  return {
    wallet: rest,
    ...valuateHoldings(holdings, defaultChainId(rest.chain), prices, assetStats),
  };
}

export type WalletWithHoldings = Wallet & { holdings: Holding[] };

/** Every active wallet, with its holdings — the exact same read used by
 * getAssetsGroupedByChain, getAssetsGroupedByTicker, and
 * getDefiGroupedByProtocol below, which used to each independently repeat
 * this query and its type-cast. Cached per-request (same reasoning as
 * getPriceMap's doc comment) — a page rendering more than one of those
 * three views in one request, which nothing currently does but nothing
 * rules out either, would otherwise fetch this identical data twice.
 *
 * `opts.userId` — same admin-only read path as getWalletsWithTotals' own
 * `opts` param (see that function's doc comment); serviceDb() + an
 * explicit user_id filter instead of userDb()'s implicit session-scoped
 * RLS, never passed from a normal page. */
export const getActiveWalletsWithHoldings = cache(async (opts?: { userId: string }): Promise<WalletWithHoldings[]> => {
  const db = opts ? serviceDb() : await userDb();
  const query = db.from("wallets").select("*, holdings(*)").eq("active", true);
  const { data, error } = await (opts ? query.eq("user_id", opts.userId) : query);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);
  return data as WalletWithHoldings[];
});

export interface AssetsResult {
  groups: ChainGroup[];
  grand: PortfolioTotal;
}

/** Every holding across every active wallet, grouped by chain rather than by wallet. */
export async function getAssetsGroupedByChain(): Promise<AssetsResult> {
  if (!(await getUser())) return { groups: [], grand: aggregate([], {}) };
  const [rows, prices, assetStats] = await Promise.all([getActiveWalletsWithHoldings(), getPriceMap(), getAssetStatsMap()]);

  const entries = rows.flatMap((wallet) =>
    wallet.holdings.map((holding) => ({
      holding: {
        ...holding,
        valuation: valueHolding(holding, prices),
        price: effectivePrice(holding, prices),
        change24h: keyChange24h(holding, assetStats),
      },
      fallbackChain: defaultChainId(wallet.chain),
    })),
  );
  const groups = groupByChain(entries, prices);

  const allHoldings = rows.flatMap((w) => w.holdings);
  const grand = aggregate(allHoldings, prices);

  return { groups, grand };
}

/** A holding as it appears inside an AssetGroup's breakdown — same shape
 * plus which wallet it came from, since that context is otherwise lost
 * once holdings from many wallets get merged into one ticker's group. */
export interface AssetHoldingEntry extends HoldingWithValuation {
  walletId: string;
  walletName: string;
  /** Resolved display chain — the holding's own `chain` when set (auto
   * holdings), else the wallet's chain normalized to the adapter-native
   * slug (see defaultChainId) for a manual holding with none of its own. */
  chainId: string;
  /** chainDisplayName(chainId), pre-resolved here rather than called from
   * AssetsTable — that's a client component, and chainDisplayName
   * transitively imports "server-only" code (evmChains.ts). */
  chainName: string;
}

export interface AssetGroup {
  /** Uppercased ticker — the actual grouping key. */
  tickerKey: string;
  /** Display ticker (formatTicker applied to whichever holding was seen
   * first) — cosmetic only, never used for grouping/lookup. */
  ticker: string;
  iconUrl: string | null;
  /** Null if not a single contributing holding had a parseable qty
   * (shouldn't happen in practice, but never silently shown as 0 — see
   * valuation.ts's top-of-file philosophy). */
  totalQty: number | null;
  total: number;
  unpricedCount: number;
  /** Per-unit price for this ticker — a single global number (see the
   * `prices` table), not a per-holding value, so it's on the group rather
   * than something callers derive from `holdings`. Null when unpriced. */
  price: number | null;
  /** 24h % change (see prices.change_24h_pct) — null when unavailable,
   * same "don't distinguish why" reasoning as `price`. */
  change24h: number | null;
  /** 1h/7d/30d % change — same contract-keyed-first-then-ticker-keyed
   * resolution as change24h (see getContractStatsMap/getPriceStatsMap).
   * Null more often than change24h: only available at all for a ticker
   * CoinGecko's /coins/markets can resolve by coin id, which both EVM
   * contract tokens and Solana SPL tokens now get via their own
   * coingecko_id cached in token_registry (see multicallEvm.ts's and
   * prices.ts's refreshCoinGeckoTickers' own doc comments) — actually
   * priced through a different, 24h-only endpoint either way, so this is
   * a second, best-effort lookup layered on top and can still come back
   * empty for a token CoinGecko hasn't cached an id for yet. */
  change1h: number | null;
  change7d: number | null;
  change30d: number | null;
  /** The asset's total market cap (not this portfolio's position size in
   * it) — same resolution as change24h. Purely informational (sort/
   * reference only), null when CoinGecko has no market cap for this asset
   * or it couldn't be resolved to a CoinGecko id. */
  marketCap: number | null;
  /** CoinGecko coin id, when resolvable — contract-based holdings get it
   * straight from token_registry (getContractStatsMap), native holdings
   * (BTC, ETH, SOL, ...) via priceKey.ts's resolveCoingeckoKey, which only
   * ever returns a real id for a holding whose ticker actually matches its
   * chain's own native asset (never guessed off a bare ticker — see that
   * file's own doc comment on the exact bug this guards against). Null
   * when neither source resolves one (an unlisted/unrecognized token) —
   * callers (AssetsTable's CoinGecko/Trend Finder links) fall back to a
   * ticker-based search/lookup rather than showing nothing. */
  coingeckoId: string | null;
  holdings: AssetHoldingEntry[];
  /** Set only by liquidStaking.ts's combined view: the staked tokens folded
   * into this base-coin row (e.g. ["weETH", "stETH"]). Its totalQty is then
   * a base-coin equivalent, shown with "≈". */
  combinedTickers?: string[];
  /** When and from where the row's price came (asset_prices), for asset
   * rows; undefined for rows priced by a stored value. */
  priceAt?: string | null;
  priceSource?: string | null;
}

export interface AssetsByTickerResult {
  groups: AssetGroup[];
  grand: PortfolioTotal;
}

/**
 * Every holding across every active wallet, one row per asset (its
 * price_key): the same BTC in two wallets, or native USDC on eight chains,
 * is one row; bridged USDC.e is its own. Holdings with no asset (protocol
 * positions, unmapped tokens) group by ticker. See getAssetsGroupedByChain
 * for the location-first cut.
 */
/** `opts.userId` — admin-only read path, see getWalletsWithTotals' own doc
 * comment for the pattern this follows. */
export async function getAssetsGroupedByTicker(opts?: { userId: string }): Promise<AssetsByTickerResult> {
  if (!opts && !(await getUser())) return { groups: [], grand: aggregate([], {}) };
  const [rows, prices, assetStats] = await Promise.all([getActiveWalletsWithHoldings(opts), getPriceMap(), getAssetStatsMap()]);

  const byTicker = new Map<string, AssetGroup>();
  // Per row: the value of the holding the row's price came from.
  const picks = new Map<string, { price: number }>();
  for (const wallet of rows) {
    for (const holding of wallet.holdings) {
      const valuation = valueHolding(holding, prices);
      const chainId = holding.chain ?? defaultChainId(wallet.chain);
      const entry: AssetHoldingEntry = {
        ...holding,
        valuation,
        price: effectivePrice(holding, prices),
        change24h: keyChange24h(holding, assetStats),
        walletId: wallet.id,
        walletName: wallet.name,
        chainId,
        chainName: chainDisplayName(chainId),
      };

      // One row per asset (docs/pricing/PLAN.md): keyed by the coin a
      // holding is priced as, so native USDC on 8 chains is one row and
      // bridged USDC.e its own. Holdings with no asset (protocol positions,
      // unmapped tokens) still group by ticker.
      const key = holding.price_key ?? `ticker:${holding.ticker.toUpperCase()}`;
      const asset = holding.price_key ? assetStats.get(holding.price_key) : undefined;
      let group = byTicker.get(key);
      if (!group) {
        group = {
          tickerKey: key,
          ticker: formatTicker(asset?.symbol ?? holding.ticker),
          iconUrl: asset?.imageUrl ?? null,
          totalQty: null,
          total: 0,
          unpricedCount: 0,
          price: null,
          change24h: null,
          change1h: null,
          change7d: null,
          change30d: null,
          marketCap: null,
          coingeckoId: null,
          holdings: [],
        };
        byTicker.set(key, group);
        // An asset row shows the asset's one price and stats — no per-
        // holding picking (Infinity: nothing overrides).
        if (asset && asset.usd !== null) {
          Object.assign(group, {
            price: asset.usd,
            change1h: asset.change1h,
            change24h: asset.change24h,
            change7d: asset.change7d,
            change30d: asset.change30d,
            marketCap: asset.marketCap,
            priceAt: asset.updatedAt,
            priceSource: asset.source,
          });
          picks.set(key, { price: Infinity });
        }
        if (holding.price_key && !holding.price_key.includes(":")) group.coingeckoId = holding.price_key;
      }

      group.holdings.push(entry);
      if (!group.iconUrl && holding.icon_url) group.iconUrl = holding.icon_url;
      // A row with no asset price (positions, unmapped tokens) shows the
      // per-unit stored value of its largest holding; it has no market
      // stats — those exist only for an asset (never borrowed by ticker).
      const weight = valuation.kind === "priced" ? valuation.usd : 0;
      const pick = picks.get(key) ?? { price: -1 };
      picks.set(key, pick);
      if (entry.price !== null && weight > pick.price) {
        group.price = entry.price;
        pick.price = weight;
      }
      const qty = parseNumeric(holding.qty);
      if (qty !== null) group.totalQty = (group.totalQty ?? 0) + qty;
      if (valuation.kind === "priced") group.total += valuation.usd;
      else group.unpricedCount += 1;
    }
  }

  const groups = [...byTicker.values()]
    .map((group) => ({ ...group, holdings: group.holdings.sort(byValueDesc) }))
    .sort((a, b) => b.total - a.total);

  const allHoldings = rows.flatMap((w) => w.holdings);
  const grand = aggregate(allHoldings, prices);

  return { groups, grand };
}

/** One wallet's positions within a single DefiProtocolGroup — see
 * getDefiGroupedByProtocol. */
export interface DefiWalletGroup {
  walletId: string;
  walletName: string;
  total: number;
  unpricedCount: number;
  positions: HoldingWithValuation[];
}

export interface DefiProtocolGroup {
  /** The adapter-supplied protocol label (e.g. "Jupiter Earn",
   * "Hyperliquid") — see AdapterHolding.protocol. This is the grouping key,
   * not the wallet's chain — a wallet with positions in two different
   * Jupiter products gets two separate groups here, same as DeBank/Rabby
   * treat each protocol/product as its own section. */
  protocol: string;
  total: number;
  unpricedCount: number;
  wallets: DefiWalletGroup[];
}

export interface DefiResult {
  groups: DefiProtocolGroup[];
  grand: PortfolioTotal;
}

/**
 * Every DeFi position across every active wallet, grouped protocol -> wallet
 * -> asset — the /defi tab's own cut, distinct from both the wallet-level
 * chain grouping (ChainGroupedHoldings, which lumps all of one wallet's DeFi
 * into a single "Solana DeFi"/"Hyperliquid" bucket — fine there since the
 * wallet's own chain already tells you what you're looking at) and the
 * ticker grouping (getAssetsGroupedByTicker, which cuts across protocols
 * entirely). Only holdings an adapter tagged with `protocol` show up here —
 * a plain token balance has none and is correctly invisible on this page.
 */
export async function getDefiGroupedByProtocol(): Promise<DefiResult> {
  if (!(await getUser())) return { groups: [], grand: aggregate([], {}) };
  const [rows, prices, assetStats] = await Promise.all([getActiveWalletsWithHoldings(), getPriceMap(), getAssetStatsMap()]);

  const byProtocol = new Map<string, Map<string, { walletName: string; holdings: Holding[] }>>();
  for (const wallet of rows) {
    for (const holding of wallet.holdings) {
      if (!holding.protocol) continue;
      let byWallet = byProtocol.get(holding.protocol);
      if (!byWallet) {
        byWallet = new Map();
        byProtocol.set(holding.protocol, byWallet);
      }
      let entry = byWallet.get(wallet.id);
      if (!entry) {
        entry = { walletName: wallet.name, holdings: [] };
        byWallet.set(wallet.id, entry);
      }
      entry.holdings.push(holding);
    }
  }

  const groups: DefiProtocolGroup[] = [...byProtocol.entries()]
    .map(([protocol, byWallet]) => {
      const wallets_: DefiWalletGroup[] = [...byWallet.entries()]
        .map(([walletId, { walletName, holdings }]) => {
          const { total, unpricedCount } = aggregate(holdings, prices);
          const positions = holdings
            .map((h) => ({
              ...h,
              valuation: valueHolding(h, prices),
              price: effectivePrice(h, prices),
              change24h: keyChange24h(h, assetStats),
            }))
            .sort(byValueDesc);
          return { walletId, walletName, total, unpricedCount, positions };
        })
        .sort((a, b) => b.total - a.total);

      const allHoldings = wallets_.flatMap((w) => w.positions);
      const { total, unpricedCount } = aggregate(allHoldings, prices);
      return { protocol, total, unpricedCount, wallets: wallets_ };
    })
    .sort((a, b) => b.total - a.total);

  const allDefiHoldings = groups.flatMap((g) => g.wallets.flatMap((w) => w.positions));
  const grand = aggregate(allDefiHoldings, prices);

  return { groups, grand };
}

export interface PortfolioHistoryPoint {
  date: string;
  total: number;
}

/**
 * Real daily value history: no `walletId` reads cryptoport.portfolio_snapshots
 * (the Dashboard trend chart), a `walletId` reads cryptoport.wallet_snapshots
 * (Analytics' per-wallet breakdown) — both written by the same once-a-day
 * Vercel Cron (see src/lib/snapshots.ts, the only writer of either table).
 * Through userDb() in both cases: each table's RLS policy scopes a select
 * to the caller's own rows, same as every other per-user read in this
 * file. Empty until the cron has run at least once since these tables were
 * created — there is no real backfill possible; see analytics.ts for the
 * estimated series Analytics stitches in front of this.
 */
/** `opts.userId` — admin-only read path, see getWalletsWithTotals' own doc
 * comment for the pattern. Only meaningful for the no-`walletId` (user-
 * level) branch below — an admin peek doesn't need per-wallet history, so
 * `wallet_snapshots` stays on userDb() (it's never reached with `opts`
 * set by any current caller). */
export async function getValueHistory(walletId?: string, opts?: { userId: string }): Promise<PortfolioHistoryPoint[]> {
  if (!opts && !(await getUser())) return [];
  const db = opts ? serviceDb() : await userDb();

  const { data, error } = walletId
    ? await db
        .from("wallet_snapshots")
        .select("snapshot_date, total_usd")
        .eq("wallet_id", walletId)
        .order("snapshot_date", { ascending: true })
    : await (opts
        ? db.from("portfolio_snapshots").select("snapshot_date, total_usd").eq("user_id", opts.userId)
        : db.from("portfolio_snapshots").select("snapshot_date, total_usd")
      ).order("snapshot_date", { ascending: true });
  if (error) throw new Error(`Failed to load value history: ${error.message}`);

  return (data as { snapshot_date: string; total_usd: number | string }[]).map((row) => ({
    date: row.snapshot_date,
    total: parseNumeric(row.total_usd) ?? 0,
  }));
}

export interface TransactionRow extends Omit<Transaction, "amount" | "fee"> {
  walletName: string;
  amount: number | null;
  fee: number | null;
  /** amount × the current price of the coin the leg is (transactionPricing.ts,
   * asset_prices) — null when either is unavailable (no single coin
   * matches, no price, or amount itself unknown), never
   * guessed at. This is a *current*-price estimate of what the moved
   * amount is worth today, not the value at the time of the transaction
   * (this app has no historical per-transaction pricing) — good enough
   * for "is this worth showing," not for anything that needs to be
   * exact. Transactions don't carry a `contract` column (unlike
   * holdings), so this can't disambiguate a ticker collision the way
   * getContractStatsMap does — a real, accepted precision gap, not an
   * oversight. */
  usdValue: number | null;
}

/**
 * `walletId` omitted reads every transaction across every active wallet
 * this user owns, newest first — RLS on cryptoport.transactions (owner-
 * only via the same wallets.user_id subquery pattern as holdings) already
 * scopes this to just their own rows, so no manual per-wallet loop/merge
 * is needed here the way the Dashboard's movers list has to do for
 * ticker-grouping. Capped at 500 rows — this is a read of already-synced,
 * already-capped-per-wallet data (see transactions/actions.ts), not a live
 * fetch, so this cap is just "don't hand the client an unbounded table,"
 * not a rate-limit concern.
 */
export async function getTransactions(walletId?: string): Promise<TransactionRow[]> {
  if (!(await getUser())) return [];
  const db = await userDb();

  const [{ data, error }, prices, wallets] = await Promise.all([
    (walletId
      ? db.from("transactions").select("*, wallets(name)").eq("wallet_id", walletId)
      : db.from("transactions").select("*, wallets(name)")
    )
      .order("occurred_at", { ascending: false })
      .limit(500),
    getPriceMap(),
    getActiveWalletsWithHoldings(),
  ]);
  if (error) throw new Error(`Failed to load transactions: ${error.message}`);
  // Priced at today's price of the coin each leg is (transactionPricing.ts).
  const holdingKeys = holdingKeyIndex(wallets.flatMap((w) => w.holdings));

  return (data as (Transaction & { wallets: { name: string } | null })[]).map((row) => {
    const amount = parseNumeric(row.amount);
    const key = transactionPriceKey(row, holdingKeys);
    const price = key ? parseNumeric(prices[key]) : null;
    return {
      ...row,
      walletName: row.wallets?.name ?? "Unknown wallet",
      amount,
      fee: parseNumeric(row.fee),
      usdValue: amount !== null && price !== null ? amount * price : null,
    };
  });
}

export interface WatchlistSummary {
  id: string;
  name: string;
  itemCount: number;
}

/** Every watchlist *this user* owns, with each list's item count — RLS on
 * cryptoport.watchlists already scopes this to auth.uid(), same "short-
 * circuit before touching Postgres for a guest" reasoning as getTags. Not
 * cached via React's cache() — unlike getTags, this is only ever read once
 * per request (the watchlist page itself), so there's no second caller in
 * the same render to dedupe against. */
export async function getWatchlists(): Promise<WatchlistSummary[]> {
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data, error } = await db
    .from("watchlists")
    .select("id, name, watchlist_items(count)")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load watchlists: ${error.message}`);

  return (data as { id: string; name: string; watchlist_items: { count: number }[] }[]).map((row) => ({
    id: row.id,
    name: row.name,
    itemCount: row.watchlist_items[0]?.count ?? 0,
  }));
}

export interface WatchlistRow {
  id: string;
  coingeckoId: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
  price: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  marketCap: number | null;
}

type WatchlistItemRow = { id: string; coingecko_id: string; ticker: string; name: string; image_url: string | null };

/** Shared by getWatchlistItems and getAllWatchlistItems: each coin's price,
 * changes and market cap from asset_prices, the same one price per coin the
 * rest of the app shows (every watchlist coin is priced in each pricing
 * pass, see assetPrices.ts's allHeldKeys). A coin not priced yet shows "—"
 * in every numeric field, never a fabricated number. */
async function withAssetStats(rows: WatchlistItemRow[]): Promise<WatchlistRow[]> {
  if (rows.length === 0) return [];
  const stats = await getAssetStatsMap();
  return rows.map((row) => {
    const s = stats.get(row.coingecko_id);
    return {
      id: row.id,
      coingeckoId: row.coingecko_id,
      ticker: row.ticker,
      name: row.name,
      imageUrl: row.image_url,
      price: s?.usd ?? null,
      change1h: s?.change1h ?? null,
      change24h: s?.change24h ?? null,
      change7d: s?.change7d ?? null,
      change30d: s?.change30d ?? null,
      marketCap: s?.marketCap ?? null,
    };
  });
}

/** One watchlist's items — RLS on watchlist_items (via the watchlists.user_id
 * subquery) already confirms this list belongs to the caller. */
export async function getWatchlistItems(watchlistId: string): Promise<WatchlistRow[]> {
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data: items, error } = await db
    .from("watchlist_items")
    .select("id, coingecko_id, ticker, name, image_url")
    .eq("watchlist_id", watchlistId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load watchlist items: ${error.message}`);

  return withAssetStats(items as WatchlistItemRow[]);
}

/** Every coin *this user* is watching, across every one of their
 * watchlists — deduped by coingecko_id (the same coin can be added to more
 * than one list; a Dashboard summary widget should count it once, not
 * once per list). Used by the Dashboard's Watchlist movers panels, which
 * have no per-list selector the way /watchlist itself does. */
export async function getAllWatchlistItems(): Promise<WatchlistRow[]> {
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data: items, error } = await db.from("watchlist_items").select("id, coingecko_id, ticker, name, image_url");
  if (error) throw new Error(`Failed to load watchlist items: ${error.message}`);

  const rows = items as WatchlistItemRow[];
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    if (seen.has(r.coingecko_id)) return false;
    seen.add(r.coingecko_id);
    return true;
  });

  return withAssetStats(deduped);
}
