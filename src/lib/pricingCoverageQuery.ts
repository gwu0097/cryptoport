import "server-only";
import { serviceDb } from "./supabase";
import { gapCause, isCoinHolding, type CoverageHolding, type GapCause, type KeyPriceState } from "./pricingCoverage.ts";

export interface CoverageGap {
  cause: GapCause;
  chain: string | null;
  ticker: string;
  /** Contract/denom, or the coin key when it has one. */
  ref: string | null;
  holdings: number;
  users: number;
  qty: number;
}

export interface CoverageReport {
  coinHoldings: number;
  unpriced: number;
  byCause: Partial<Record<GapCause, number>>;
  gaps: CoverageGap[];
}

type Row = CoverageHolding & { qty: number | string | null; wallets: { user_id: string } };

/** Every coin holding in every active wallet, and why each unpriced one is
 * unpriced. Admin-only: callers must have called requireAdmin(). Reads with
 * the service client (every user's rows), paged in id order. */
export async function getPricingCoverage(): Promise<CoverageReport> {
  const db = serviceDb();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("holdings")
      .select("id, ticker, chain, contract, source, protocol_section, coingecko_id, price_key, qty, wallets!inner(user_id, active)")
      .eq("wallets.active", true)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read holdings: ${error.message}`);
    rows.push(...(data as unknown as Row[]));
    if (data.length < 1000) break;
  }

  const coins = rows.filter(isCoinHolding);
  const keys = [...new Set(coins.map((r) => r.price_key).filter((k): k is string => !!k))];
  const prices = new Map<string, KeyPriceState>();
  for (let i = 0; i < keys.length; i += 300) {
    const { data, error } = await db.from("asset_prices").select("price_key, usd, missing_since").in("price_key", keys.slice(i, i + 300));
    if (error) throw new Error(`Failed to read asset prices: ${error.message}`);
    for (const p of data as { price_key: string; usd: number | string | null; missing_since: string | null }[]) {
      prices.set(p.price_key, { usd: p.usd === null ? null : Number(p.usd), missing_since: p.missing_since });
    }
  }

  const byCause: Partial<Record<GapCause, number>> = {};
  const groups = new Map<string, CoverageGap & { userIds: Set<string> }>();
  for (const r of coins) {
    const cause = gapCause(r, prices);
    if (!cause) continue;
    byCause[cause] = (byCause[cause] ?? 0) + 1;
    const ref = r.price_key ?? r.contract;
    const k = `${cause}|${r.chain}|${r.ticker}|${ref}`;
    const g = groups.get(k) ?? { cause, chain: r.chain, ticker: r.ticker, ref, holdings: 0, users: 0, qty: 0, userIds: new Set<string>() };
    g.holdings++;
    g.qty += Number(r.qty ?? 0);
    g.userIds.add(r.wallets.user_id);
    groups.set(k, g);
  }
  const gaps = [...groups.values()].map(({ userIds, ...g }) => ({ ...g, users: userIds.size }));
  return { coinHoldings: coins.length, unpriced: gaps.reduce((s, g) => s + g.holdings, 0), byCause, gaps };
}
