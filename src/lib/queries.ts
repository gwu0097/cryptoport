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
import { chainDisplayName, defaultChainId } from "./chainNames";
import { formatTicker } from "./format";
import { pinnedWalletChain, externalPortfolioViewer, type WalletChain } from "./walletDisplay.ts";
import type { Holding, LinkedWallet, Price, Tag, Transaction, Wallet, WalletWithTag } from "./types";

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
  /** Per-lane ("coingecko" | "coinbase" | "evm") live status/timing for the
   * current or most recent refresh — see prices.ts's refreshPrices, which
   * writes this incrementally as each lane finishes rather than only once
   * at the very end. Null before the very first refresh this app has ever
   * run. */
  phases: PriceRefreshPhases | null;
}

/** The one global "prices last refreshed" timestamp — see
 * price_refresh_state in schema.sql for why this is a singleton row rather
 * than something stamped onto every wallet. Cached per-request via React's
 * cache() — same reasoning as every other function in this file that does,
 * see getPriceMap's doc comment. */
export const getPriceRefreshState = cache(async (): Promise<PriceRefreshState> => {
  const { data, error } = await serviceDb()
    .from("price_refresh_state")
    .select("refreshed_at, status, started_at, phases")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load price refresh state: ${error.message}`);
  return {
    refreshedAt: data?.refreshed_at ?? null,
    status: data?.status ?? null,
    startedAt: data?.started_at ?? null,
    phases: (data?.phases as PriceRefreshPhases | null) ?? null,
  };
});

export interface TokenRegistryState {
  refreshedAt: string | null;
  status: string | null;
  startedAt: string | null;
}

/** Same singleton-row pattern as getPriceRefreshState, for the "Refresh
 * token list" button — see token_registry_state in schema.sql. Cached
 * per-request via React's cache(), same reasoning as every other function
 * in this file that does. */
export const getTokenRegistryState = cache(async (): Promise<TokenRegistryState> => {
  const { data, error } = await serviceDb()
    .from("token_registry_state")
    .select("refreshed_at, status, started_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load token registry state: ${error.message}`);
  return {
    refreshedAt: data?.refreshed_at ?? null,
    status: data?.status ?? null,
    startedAt: data?.started_at ?? null,
  };
});

/** Every tag *this user* has ever created — populates the datalist for the
 * free-text "tag" input on the wallet add/edit forms (see resolveTagId in
 * wallets/actions.ts, which creates one the first time its name is used).
 * No explicit user filter here — RLS on cryptoport.tags already scopes
 * this to auth.uid(), see db/schema.sql. Cached per-request via React's
 * cache() — same reasoning as getPriceMap's doc comment. */
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

/** chain id (evmChains.ts id, or 'solana' | 'hyperliquid') -> logo URL —
 * see coingecko.ts's refreshTokenRegistry for how this is kept populated.
 * Shared/global, not per-user — serviceDb() is correct here. Cached
 * per-request — same reasoning as getPriceMap's doc comment. */
export const getChainIconMap = cache(async (): Promise<Record<string, string>> => {
  const { data, error } = await serviceDb().from("chain_icons").select("chain_id, image_url");
  if (error) throw new Error(`Failed to load chain_icons: ${error.message}`);

  const icons: Record<string, string> = {};
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
export const getPriceMap = cache(async (): Promise<PriceMap> => {
  const { data, error } = await serviceDb().from("prices").select("ticker, usd");
  if (error) throw new Error(`Failed to load prices: ${error.message}`);

  const prices: PriceMap = {};
  for (const row of data as Pick<Price, "ticker" | "usd">[]) {
    prices[row.ticker] = row.usd;
  }
  return prices;
});

/** A separate query rather than folding into PriceMap/getPriceMap — that
 * type is threaded through valuation.ts/aggregate/effectivePrice, all of
 * which only ever want the raw usd value; changing its shape to also carry
 * these stats would ripple into every one of those for fields only the
 * Assets page currently needs.
 *
 * One shape for both the ticker-keyed (`prices`) and contract-keyed
 * (`token_registry`) lookups below — used to be 4 near-identical map
 * functions (a change map + a market-cap map, each duplicated once for
 * contracts), which was already the "two is the threshold" signal before
 * 1h/7d/30d would have made it 10. */
export interface PriceStats {
  change24h: number | null;
  change1h: number | null;
  change7d: number | null;
  change30d: number | null;
  marketCap: number | null;
}
export type PriceStatsMap = Record<string, PriceStats>;

/** Cached per-request — same reasoning as getPriceMap's doc comment. */
export const getPriceStatsMap = cache(async (): Promise<PriceStatsMap> => {
  const { data, error } = await serviceDb()
    .from("prices")
    .select("ticker, change_24h_pct, change_1h_pct, change_7d_pct, change_30d_pct, market_cap");
  if (error) throw new Error(`Failed to load price stats: ${error.message}`);

  const stats: PriceStatsMap = {};
  for (const row of data as {
    ticker: string;
    change_24h_pct: number | string | null;
    change_1h_pct: number | string | null;
    change_7d_pct: number | string | null;
    change_30d_pct: number | string | null;
    market_cap: number | string | null;
  }[]) {
    stats[row.ticker] = {
      change24h: parseNumeric(row.change_24h_pct),
      change1h: parseNumeric(row.change_1h_pct),
      change7d: parseNumeric(row.change_7d_pct),
      change30d: parseNumeric(row.change_30d_pct),
      marketCap: parseNumeric(row.market_cap),
    };
  }
  return stats;
});

/** lowercase contract -> stats, from token_registry (see multicallEvm.ts's
 * saveMarketStats). EVM holdings are valued via usd_override and never
 * touch the ticker-keyed `prices` table (see valuation.ts) — this is the
 * equivalent lookup for those, keyed by contract instead of ticker so it
 * can't cross-contaminate across chains or ticker collisions. Not
 * chain-scoped even though token_registry's key is (chain_id, contract): a
 * contract address is already globally unique in practice, and a holding's
 * own `contract` field carries no chain_id to join on without a second
 * query — the same simplification effectivePrice already makes for
 * ticker-keyed prices. Cached per-request — same reasoning as
 * getPriceMap's doc comment. */
export const getContractStatsMap = cache(async (): Promise<PriceStatsMap> => {
  // Excludes rows with no 24h change up front — token_registry has tens of
  // thousands of contracts per chain from refreshTokenRegistry's coins/list
  // import, the overwhelming majority never actually held/synced. Only the
  // ones a sync has actually priced (which always sets change_24h_pct,
  // even when 1h/7d/30d couldn't be resolved — see saveMarketStats) are
  // useful here.
  const { data, error } = await serviceDb()
    .from("token_registry")
    .select("contract, change_24h_pct, change_1h_pct, change_7d_pct, change_30d_pct, market_cap")
    .not("change_24h_pct", "is", null);
  if (error) throw new Error(`Failed to load token registry stats: ${error.message}`);

  const stats: PriceStatsMap = {};
  for (const row of data as {
    contract: string;
    change_24h_pct: number | string | null;
    change_1h_pct: number | string | null;
    change_7d_pct: number | string | null;
    change_30d_pct: number | string | null;
    market_cap: number | string | null;
  }[]) {
    stats[row.contract.toLowerCase()] = {
      change24h: parseNumeric(row.change_24h_pct),
      change1h: parseNumeric(row.change_1h_pct),
      change7d: parseNumeric(row.change_7d_pct),
      change30d: parseNumeric(row.change_30d_pct),
      marketCap: parseNumeric(row.market_cap),
    };
  }
  return stats;
});

// The ticker-keyed `prices` table is deliberately never consulted for a
// holding that already carries usd_override (see valuation.ts) — but the
// per-unit "Price" column still wants a number to show instead of a
// misleading "unpriced" on a row that clearly has a value. Derived only for
// display; never fed back into valuation.
function effectivePrice(holding: Pick<Holding, "usd_override" | "qty" | "ticker">, prices: PriceMap): number | null {
  const override = parseNumeric(holding.usd_override);
  const qty = parseNumeric(holding.qty);
  if (override !== null && qty !== null && qty !== 0) return override / qty;
  return parseNumeric(prices[holding.ticker]);
}

export interface WalletWithTotal extends WalletWithTag {
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
export async function getWalletsWithTotals(): Promise<WalletListResult> {
  if (!(await getUser())) return { wallets: [], grand: aggregate([], {}) };
  const db = await userDb();
  const [{ data: wallets, error: walletsError }, prices, linkedWallets] = await Promise.all([
    db
      .from("wallets")
      .select("*, holdings(*), tag:tags(id,name)")
      .eq("active", true)
      .order("created_at", { ascending: true }),
    getPriceMap(),
    getLinkedWallets(),
  ]);
  if (walletsError) throw new Error(`Failed to load wallets: ${walletsError.message}`);

  type WalletRow = WalletWithTag & { holdings: Holding[] };
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
 * (manual rows, or pre-chain-column sync rows). */
export function valuateHoldings(
  holdings: Holding[],
  fallbackChain: string,
  prices: PriceMap,
): ValuatedHoldings {
  const holdingsWithValuation: HoldingWithValuation[] = holdings.map((holding) => ({
    ...holding,
    valuation: valueHolding(holding, prices),
    price: effectivePrice(holding, prices),
  }));
  const chainGroups = groupByChain(
    holdingsWithValuation.map((holding) => ({ holding, fallbackChain })),
    prices,
  );
  const { total, unpricedCount } = aggregate(holdings, prices);

  return { holdings: holdingsWithValuation, chainGroups, total, unpricedCount };
}

export interface WalletDetailResult extends ValuatedHoldings {
  wallet: WalletWithTag;
}

export async function getWalletDetail(id: string): Promise<WalletDetailResult | null> {
  // Belt and suspenders — wallets/[id]/page.tsx checks getUser() itself and
  // redirects a guest to /login before ever calling this, but this stays
  // guarded too rather than relying solely on the caller to do it first.
  if (!(await getUser())) return null;
  const db = await userDb();
  const [{ data: wallet, error: walletError }, prices] = await Promise.all([
    db.from("wallets").select("*, holdings(*), tag:tags(id,name)").eq("id", id).maybeSingle(),
    getPriceMap(),
  ]);
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet) return null;

  const { holdings, ...rest } = wallet as WalletWithTag & { holdings: Holding[] };
  return { wallet: rest, ...valuateHoldings(holdings, defaultChainId(rest.chain), prices) };
}

export type WalletWithHoldings = Wallet & { holdings: Holding[] };

/** Every active wallet, with its holdings — the exact same read used by
 * getAssetsGroupedByChain, getAssetsGroupedByTicker, and
 * getDefiGroupedByProtocol below, which used to each independently repeat
 * this query and its type-cast. Cached per-request (same reasoning as
 * getPriceMap's doc comment) — a page rendering more than one of those
 * three views in one request, which nothing currently does but nothing
 * rules out either, would otherwise fetch this identical data twice. */
export const getActiveWalletsWithHoldings = cache(async (): Promise<WalletWithHoldings[]> => {
  const db = await userDb();
  const { data, error } = await db.from("wallets").select("*, holdings(*)").eq("active", true);
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
  const [rows, prices] = await Promise.all([getActiveWalletsWithHoldings(), getPriceMap()]);

  const entries = rows.flatMap((wallet) =>
    wallet.holdings.map((holding) => ({
      holding: {
        ...holding,
        valuation: valueHolding(holding, prices),
        price: effectivePrice(holding, prices),
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
  holdings: AssetHoldingEntry[];
}

export interface AssetsByTickerResult {
  groups: AssetGroup[];
  grand: PortfolioTotal;
}

/**
 * Every holding across every active wallet, grouped by ticker — the same
 * BTC held in two different wallets is one row here (see getAssetsGroupedByChain
 * above for the "same coin, wherever it is" location-first cut instead).
 * Grouped by ticker rather than a stricter per-token identity (e.g.
 * CoinGecko's coin id, which would correctly merge USDC-on-Ethereum and
 * USDC-on-Base as the literal same asset while never conflating two
 * unrelated tokens that happen to share a symbol) — ticker is what the rest
 * of this app already keys pricing and display on (see the `prices` table),
 * so this stays consistent with that rather than introducing a second,
 * stricter notion of "same asset" just for this one page.
 */
export async function getAssetsGroupedByTicker(): Promise<AssetsByTickerResult> {
  if (!(await getUser())) return { groups: [], grand: aggregate([], {}) };
  const [rows, prices, priceStats, contractStats] = await Promise.all([
    getActiveWalletsWithHoldings(),
    getPriceMap(),
    getPriceStatsMap(),
    getContractStatsMap(),
  ]);

  const byTicker = new Map<string, AssetGroup>();
  for (const wallet of rows) {
    for (const holding of wallet.holdings) {
      const valuation = valueHolding(holding, prices);
      const chainId = holding.chain ?? defaultChainId(wallet.chain);
      const entry: AssetHoldingEntry = {
        ...holding,
        valuation,
        price: effectivePrice(holding, prices),
        walletId: wallet.id,
        walletName: wallet.name,
        chainId,
        chainName: chainDisplayName(chainId),
      };

      const key = holding.ticker.toUpperCase();
      let group = byTicker.get(key);
      if (!group) {
        group = {
          tickerKey: key,
          ticker: formatTicker(holding.ticker),
          iconUrl: null,
          totalQty: null,
          total: 0,
          unpricedCount: 0,
          price: null,
          change24h: null,
          change1h: null,
          change7d: null,
          change30d: null,
          marketCap: null,
          holdings: [],
        };
        byTicker.set(key, group);
      }

      group.holdings.push(entry);
      if (!group.iconUrl && holding.icon_url) group.iconUrl = holding.icon_url;
      // Filled in from each holding's own already-resolved price (entry.price
      // via effectivePrice) rather than a second lookup by the group's
      // uppercased key — a group can merge holdings whose raw ticker casing
      // differs (that's the whole reason grouping uppercases at all), and
      // `prices` is keyed by that raw, possibly mixed-case string, so an
      // uppercase-key lookup here could miss a real price that only exists
      // under the original casing.
      if (group.price === null && entry.price !== null) group.price = entry.price;
      // Contract-keyed first — EVM holdings are valued via usd_override and
      // never touch the ticker-keyed `prices` table (see valuation.ts), so
      // priceStats[ticker] is never populated for them; getContractStatsMap
      // is the equivalent lookup for those. Falls back to the ticker table
      // for everything else (Coinbase/Jupiter/CoinGecko-native-priced
      // holdings, which have no `contract`).
      //
      // Resolved independently per field, not as one whole-object fallback
      // — a contract can have a real change_24h_pct (the getContractStatsMap
      // filter's condition) while still missing e.g. change_1h_pct this
      // cycle (see multicallEvm.ts's multiWindowRows), and the ticker-keyed
      // table might separately have that field filled in for the same
      // ticker from another holding. Falling back to the ticker source for
      // just that one still-missing field (rather than giving up once the
      // contract source is found at all) is a genuine improvement a
      // whole-object fallback would silently lose.
      const contractRowStats = holding.contract ? contractStats[holding.contract.toLowerCase()] : undefined;
      const tickerRowStats = priceStats[holding.ticker];
      const change24h = contractRowStats?.change24h ?? tickerRowStats?.change24h;
      const change1h = contractRowStats?.change1h ?? tickerRowStats?.change1h;
      const change7d = contractRowStats?.change7d ?? tickerRowStats?.change7d;
      const change30d = contractRowStats?.change30d ?? tickerRowStats?.change30d;
      const marketCap = contractRowStats?.marketCap ?? tickerRowStats?.marketCap;
      if (group.change24h === null && change24h != null) group.change24h = change24h;
      if (group.change1h === null && change1h != null) group.change1h = change1h;
      if (group.change7d === null && change7d != null) group.change7d = change7d;
      if (group.change30d === null && change30d != null) group.change30d = change30d;
      if (group.marketCap === null && marketCap != null) group.marketCap = marketCap;
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
  const [rows, prices] = await Promise.all([getActiveWalletsWithHoldings(), getPriceMap()]);

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
            .map((h) => ({ ...h, valuation: valueHolding(h, prices), price: effectivePrice(h, prices) }))
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
export async function getValueHistory(walletId?: string): Promise<PortfolioHistoryPoint[]> {
  if (!(await getUser())) return [];
  const db = await userDb();

  const { data, error } = walletId
    ? await db
        .from("wallet_snapshots")
        .select("snapshot_date, total_usd")
        .eq("wallet_id", walletId)
        .order("snapshot_date", { ascending: true })
    : await db.from("portfolio_snapshots").select("snapshot_date, total_usd").order("snapshot_date", { ascending: true });
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
  /** amount × the ticker's current price (same ticker-keyed `prices`
   * table getPriceMap uses everywhere else) — null when either is
   * unavailable (unpriced ticker, or amount itself unknown), never
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

  const [{ data, error }, prices] = await Promise.all([
    (walletId
      ? db.from("transactions").select("*, wallets(name)").eq("wallet_id", walletId)
      : db.from("transactions").select("*, wallets(name)")
    )
      .order("occurred_at", { ascending: false })
      .limit(500),
    getPriceMap(),
  ]);
  if (error) throw new Error(`Failed to load transactions: ${error.message}`);

  return (data as (Transaction & { wallets: { name: string } | null })[]).map((row) => {
    const amount = parseNumeric(row.amount);
    const price = row.ticker ? parseNumeric(prices[row.ticker]) : null;
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

/** Shared by getWatchlistItems and getAllWatchlistItems — merges item rows
 * in code against the shared, coingecko-id-keyed cryptoport.coin_market_data
 * (see coinMarketData.ts's own doc comment for why this is id-keyed rather
 * than reusing the ticker-keyed `prices` table getPriceMap reads). Two
 * plain queries, not a PostgREST embedded-relationship select, since
 * there's deliberately no foreign key from watchlist_items.coingecko_id to
 * coin_market_data.coingecko_id (a newly-added coin's item row is saved
 * before its market-data row exists — see addWatchlistItem's own comment —
 * so a FK here would make that insert fail). A coin with no market_data
 * row yet (just added, not refreshed) or one CoinGecko no longer returns
 * data for renders every numeric field null — "—", never a fabricated
 * number. */
async function mergeWithMarketData(
  rows: WatchlistItemRow[],
  db: Awaited<ReturnType<typeof userDb>>,
): Promise<WatchlistRow[]> {
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.coingecko_id))];
  const { data: marketRows, error: marketError } = await db
    .from("coin_market_data")
    .select("coingecko_id, price_usd, change_1h, change_24h, change_7d, change_30d, market_cap")
    .in("coingecko_id", ids);
  if (marketError) throw new Error(`Failed to load coin market data: ${marketError.message}`);

  type MarketRow = {
    coingecko_id: string;
    price_usd: number | null;
    change_1h: number | null;
    change_24h: number | null;
    change_7d: number | null;
    change_30d: number | null;
    market_cap: number | null;
  };
  const marketById = new Map((marketRows as MarketRow[]).map((m) => [m.coingecko_id, m]));

  return rows.map((row) => {
    const market = marketById.get(row.coingecko_id) ?? null;
    return {
      id: row.id,
      coingeckoId: row.coingecko_id,
      ticker: row.ticker,
      name: row.name,
      imageUrl: row.image_url,
      price: parseNumeric(market?.price_usd ?? null),
      change1h: parseNumeric(market?.change_1h ?? null),
      change24h: parseNumeric(market?.change_24h ?? null),
      change7d: parseNumeric(market?.change_7d ?? null),
      change30d: parseNumeric(market?.change_30d ?? null),
      marketCap: parseNumeric(market?.market_cap ?? null),
    };
  });
}

/** One watchlist's items — RLS on watchlist_items (via the watchlists.user_id
 * subquery) already confirms this list belongs to the caller;
 * coin_market_data's own policy opens select to every signed-in user (it's
 * global market data, not per-user). */
export async function getWatchlistItems(watchlistId: string): Promise<WatchlistRow[]> {
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data: items, error } = await db
    .from("watchlist_items")
    .select("id, coingecko_id, ticker, name, image_url")
    .eq("watchlist_id", watchlistId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load watchlist items: ${error.message}`);

  return mergeWithMarketData(items as WatchlistItemRow[], db);
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

  return mergeWithMarketData(deduped, db);
}
