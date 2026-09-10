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
import { chainDisplayName } from "./chainNames";
import type { Holding, Price, Wallet } from "./types";

async function getPriceMap(): Promise<PriceMap> {
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

export interface WalletWithTotal extends Wallet {
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
      .select("*, holdings(*)")
      .eq("active", true)
      .order("created_at", { ascending: true }),
    getPriceMap(),
  ]);
  if (walletsError) throw new Error(`Failed to load wallets: ${walletsError.message}`);

  type WalletRow = Wallet & { holdings: Holding[] };
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

export interface WalletDetailResult {
  wallet: Wallet;
  holdings: HoldingWithValuation[];
  chainGroups: ChainGroup[];
  total: number;
  unpricedCount: number;
}

export async function getWalletDetail(id: string): Promise<WalletDetailResult | null> {
  const [{ data: wallet, error: walletError }, prices] = await Promise.all([
    portfolioDb().from("wallets").select("*, holdings(*)").eq("id", id).maybeSingle(),
    getPriceMap(),
  ]);
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet) return null;

  const { holdings, ...rest } = wallet as Wallet & { holdings: Holding[] };
  const holdingsWithValuation: HoldingWithValuation[] = holdings.map((holding) => ({
    ...holding,
    valuation: valueHolding(holding, prices),
    price: effectivePrice(holding, prices),
  }));
  const chainGroups = groupByChain(
    holdingsWithValuation.map((holding) => ({ holding, fallbackChain: rest.chain })),
    prices,
  );
  const { total, unpricedCount } = aggregate(holdings, prices);

  return { wallet: rest, holdings: holdingsWithValuation, chainGroups, total, unpricedCount };
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
      fallbackChain: wallet.chain,
    })),
  );
  const groups = groupByChain(entries, prices);

  const allHoldings = rows.flatMap((w) => w.holdings);
  const grand = aggregate(allHoldings, prices);

  return { groups, grand };
}
