import "server-only";
import { serviceDb, userDb } from "./supabase";
import { getUser } from "./auth";
import { isPositionValue, VENUE_CHAINS } from "./assetIdentity.ts";
import { classifyMapping, type MatchKind } from "./exchangeMappings.ts";

export interface ExchangeMappingRow {
  venue: string;
  ticker: string;
  qty: number;
  priceKey: string | null;
  /** The coin it's priced as, from `assets` (null until first priced). */
  coinSymbol: string | null;
  coinName: string | null;
  usd: number | null;
  match: MatchKind;
}

/** Every exchange/venue ticker this user holds (one row per venue+ticker),
 * with the coin it's priced as and how that coin was chosen — the Settings
 * review of exchange_assets. Protocol positions (perps, prediction shares)
 * are left out: they're valued by the protocol, not mapped to a coin. */
export async function getExchangeMappings(): Promise<ExchangeMappingRow[]> {
  if (!(await getUser())) return [];
  const db = await userDb();
  const { data, error } = await db
    .from("wallets")
    .select("holdings(ticker, chain, qty, price_key, protocol_section, source, contract)")
    .eq("active", true)
    .in("holdings.chain", [...VENUE_CHAINS]);
  if (error) throw new Error(`Failed to load exchange holdings: ${error.message}`);

  type H = { ticker: string; chain: string | null; qty: number | string | null; price_key: string | null; protocol_section: string | null; source: string; contract: string | null };
  const byTicker = new Map<string, ExchangeMappingRow>();
  for (const w of data as { holdings: H[] }[]) {
    for (const h of w.holdings) {
      if (!h.chain || !VENUE_CHAINS.has(h.chain) || isPositionValue(h)) continue;
      const k = `${h.chain}|${h.ticker.toUpperCase()}`;
      const row = byTicker.get(k);
      if (row) row.qty += Number(h.qty ?? 0);
      else
        byTicker.set(k, {
          venue: h.chain,
          ticker: h.ticker.toUpperCase(),
          qty: Number(h.qty ?? 0),
          priceKey: h.price_key,
          coinSymbol: null,
          coinName: null,
          usd: null,
          match: "unpriced",
        });
    }
  }
  const rows = [...byTicker.values()];
  if (rows.length === 0) return rows;

  // Shared tables (no user data): read with the service client.
  const svc = serviceDb();
  const keys = [...new Set(rows.map((r) => r.priceKey).filter((k): k is string => !!k))];
  const [mappings, assets, prices] = await Promise.all([
    svc.from("exchange_assets").select("exchange, ticker, mapping_source").in("ticker", [...new Set(rows.map((r) => r.ticker))]),
    keys.length ? svc.from("assets").select("price_key, symbol, name").in("price_key", keys) : Promise.resolve({ data: [], error: null }),
    keys.length ? svc.from("asset_prices").select("price_key, usd").in("price_key", keys) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [mappings, assets, prices]) if (r.error) throw new Error(`Failed to load exchange mappings: ${r.error.message}`);

  const sources = new Map((mappings.data as { exchange: string; ticker: string; mapping_source: string }[]).map((m) => [`${m.exchange}|${m.ticker.toUpperCase()}`, m.mapping_source]));
  const info = new Map((assets.data as { price_key: string; symbol: string | null; name: string | null }[]).map((a) => [a.price_key, a]));
  const usd = new Map((prices.data as { price_key: string; usd: number | string | null }[]).map((p) => [p.price_key, p.usd === null ? null : Number(p.usd)]));
  for (const r of rows) {
    r.match = classifyMapping({ venue: r.venue, ticker: r.ticker, price_key: r.priceKey }, sources);
    if (!r.priceKey) continue;
    r.coinSymbol = info.get(r.priceKey)?.symbol ?? null;
    r.coinName = info.get(r.priceKey)?.name ?? null;
    r.usd = usd.get(r.priceKey) ?? null;
  }
  return rows;
}
