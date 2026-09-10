import "server-only";
import { portfolioDb } from "./supabase";
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
import type { Holding, Price, Tag, Wallet, WalletWithTag } from "./types";

export interface PriceRefreshState {
  refreshedAt: string | null;
  status: string | null;
}

/** The one global "prices last refreshed" timestamp — see
 * price_refresh_state in schema.sql for why this is a singleton row rather
 * than something stamped onto every wallet. */
export async function getPriceRefreshState(): Promise<PriceRefreshState> {
  const { data, error } = await portfolioDb()
    .from("price_refresh_state")
    .select("refreshed_at, status")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load price refresh state: ${error.message}`);
  return { refreshedAt: data?.refreshed_at ?? null, status: data?.status ?? null };
}

/** Every tag that's ever been created — populates the datalist for the
 * free-text "tag" input on the wallet add/edit forms (see resolveTagId in
 * wallets/actions.ts, which creates one the first time its name is used). */
export async function getTags(): Promise<Tag[]> {
  const { data, error } = await portfolioDb().from("tags").select("id, name").order("name");
  if (error) throw new Error(`Failed to load tags: ${error.message}`);
  return data as Tag[];
}

/** chain id (evmChains.ts id, or 'solana' | 'hyperliquid') -> logo URL —
 * see coingecko.ts's refreshTokenRegistry for how this is kept populated. */
export async function getChainIconMap(): Promise<Record<string, string>> {
  const { data, error } = await portfolioDb().from("chain_icons").select("chain_id, image_url");
  if (error) throw new Error(`Failed to load chain_icons: ${error.message}`);

  const icons: Record<string, string> = {};
  for (const row of data as { chain_id: string; image_url: string }[]) {
    icons[row.chain_id] = row.image_url;
  }
  return icons;
}

export async function getPriceMap(): Promise<PriceMap> {
  const { data, error } = await portfolioDb().from("prices").select("ticker, usd");
  if (error) throw new Error(`Failed to load prices: ${error.message}`);

  const prices: PriceMap = {};
  for (const row of data as Pick<Price, "ticker" | "usd">[]) {
    prices[row.ticker] = row.usd;
  }
  return prices;
}

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
}

export interface WalletListResult {
  wallets: WalletWithTotal[];
  grand: PortfolioTotal;
}

/** Wallets list, each with its own total, plus a grand total across all of them. */
export async function getWalletsWithTotals(): Promise<WalletListResult> {
  const [{ data: wallets, error: walletsError }, prices] = await Promise.all([
    portfolioDb()
      .from("wallets")
      .select("*, holdings(*), tag:tags(id,name)")
      .eq("active", true)
      .order("created_at", { ascending: true }),
    getPriceMap(),
  ]);
  if (walletsError) throw new Error(`Failed to load wallets: ${walletsError.message}`);

  type WalletRow = WalletWithTag & { holdings: Holding[] };
  const rows = wallets as WalletRow[];

  const walletsWithTotals = rows.map((wallet) => {
    const { holdings, ...rest } = wallet;
    const { total, unpricedCount } = aggregate(holdings, prices);
    return { ...rest, total, unpricedCount };
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
  const [{ data: wallet, error: walletError }, prices] = await Promise.all([
    portfolioDb().from("wallets").select("*, holdings(*), tag:tags(id,name)").eq("id", id).maybeSingle(),
    getPriceMap(),
  ]);
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet) return null;

  const { holdings, ...rest } = wallet as WalletWithTag & { holdings: Holding[] };
  return { wallet: rest, ...valuateHoldings(holdings, defaultChainId(rest.chain), prices) };
}

export interface AssetsResult {
  groups: ChainGroup[];
  grand: PortfolioTotal;
}

/** Every holding across every active wallet, grouped by chain rather than by wallet. */
export async function getAssetsGroupedByChain(): Promise<AssetsResult> {
  const [{ data: wallets, error }, prices] = await Promise.all([
    portfolioDb().from("wallets").select("*, holdings(*)").eq("active", true),
    getPriceMap(),
  ]);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);

  type WalletRow = Wallet & { holdings: Holding[] };
  const rows = wallets as WalletRow[];

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
  const [{ data: wallets, error }, prices] = await Promise.all([
    portfolioDb().from("wallets").select("*, holdings(*)").eq("active", true),
    getPriceMap(),
  ]);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);

  type WalletRow = Wallet & { holdings: Holding[] };
  const rows = wallets as WalletRow[];

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
          holdings: [],
        };
        byTicker.set(key, group);
      }

      group.holdings.push(entry);
      if (!group.iconUrl && holding.icon_url) group.iconUrl = holding.icon_url;
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
