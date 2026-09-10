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

export interface WalletDetailResult {
  wallet: Wallet;
  holdings: HoldingWithValuation[];
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
  const holdingsWithValuation = holdings.map((holding) => ({
    ...holding,
    valuation: valueHolding(holding, prices),
    price: parseNumeric(prices[holding.ticker]),
  }));
  const { total, unpricedCount } = aggregate(holdings, prices);

  return { wallet: rest, holdings: holdingsWithValuation, total, unpricedCount };
}
