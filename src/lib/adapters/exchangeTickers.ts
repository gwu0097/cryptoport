import "server-only";
import { serviceDb } from "../supabase";
import { coingeckoFetch } from "./coingeckoFetch";
import { withPriceKeys } from "./assetKeys";
import { ensureAssetPrices } from "./assetPrices";
import { COINGECKO_EXCHANGE_IDS, mappingsFromTickers, type ExchangeTicker } from "../exchangeTickers";

// Keeps exchange_assets current for Kraken, Gemini and MEXC from CoinGecko's
// own per-exchange data (see ../exchangeTickers.ts), then re-keys the
// exchange holdings it changes and prices any new coins — so a new user's
// exchange tickers map without anyone editing a table. ~35 CoinGecko calls
// (100 pairs a page: Kraken ~15, MEXC ~19, Gemini 1, measured 2026-09-25),
// weekly. Hand-set rows (mapping_source 'manual') are never overwritten.

const API_BASE = "https://api.coingecko.com/api/v3";
const PER_PAGE = 100;
const MAX_PAGES = 40;
const SOURCE = "coingecko-exchange";

async function fetchExchangeTickers(coingeckoId: string): Promise<ExchangeTicker[]> {
  const out: ExchangeTicker[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await coingeckoFetch(`${API_BASE}/exchanges/${coingeckoId}/tickers?page=${page}`);
    if (!res.ok) throw new Error(`CoinGecko ${coingeckoId} tickers page ${page}: HTTP ${res.status}`);
    const tickers = ((await res.json()) as { tickers?: ExchangeTicker[] }).tickers ?? [];
    out.push(...tickers);
    if (tickers.length < PER_PAGE) break;
  }
  return out;
}

type HoldingRow = { id: string; ticker: string; chain: string | null; contract: string | null; source: string; protocol_section: string | null; coingecko_id: string | null; price_key: string | null };

/** Re-keys every exchange holding whose key the new mappings change. */
async function rekeyExchangeHoldings(exchanges: string[]): Promise<string[]> {
  const db = serviceDb();
  const { data, error } = await db
    .from("holdings")
    .select("id, ticker, chain, contract, source, protocol_section, coingecko_id, price_key")
    .eq("source", "auto_exchange")
    .in("chain", exchanges);
  if (error) throw new Error(`Failed to read exchange holdings: ${error.message}`);
  const rows = data as HoldingRow[];
  const keyed = await withPriceKeys(rows, "auto_exchange");
  const changed = keyed.filter((r, i) => r.price_key !== rows[i].price_key);
  for (const r of changed) {
    const { error: e } = await db.from("holdings").update({ price_key: r.price_key }).eq("id", r.id);
    if (e) throw new Error(`Failed to re-key ${r.chain} ${r.ticker}: ${e.message}`);
  }
  return [...new Set(changed.map((r) => r.price_key).filter((k): k is string => !!k))];
}

/** One pass over every exchange; each fails on its own. Returns a summary. */
export async function refreshExchangeAssets(): Promise<string> {
  const db = serviceDb();
  const parts: string[] = [];
  const done: string[] = [];
  for (const [exchange, coingeckoId] of Object.entries(COINGECKO_EXCHANGE_IDS)) {
    try {
      const mappings = mappingsFromTickers(exchange, await fetchExchangeTickers(coingeckoId));
      const { data: manual, error } = await db.from("exchange_assets").select("ticker").eq("exchange", exchange).eq("mapping_source", "manual");
      if (error) throw new Error(error.message);
      const handSet = new Set((manual as { ticker: string }[]).map((r) => r.ticker));
      const now = new Date().toISOString();
      const rows = [...mappings]
        .filter(([ticker]) => !handSet.has(ticker))
        .map(([ticker, price_key]) => ({ exchange, ticker, price_key, mapping_source: SOURCE, updated_at: now }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error: e } = await db.from("exchange_assets").upsert(rows.slice(i, i + 500), { onConflict: "exchange,ticker" });
        if (e) throw new Error(e.message);
      }
      parts.push(`${exchange} ${rows.length}`);
      done.push(exchange);
    } catch (e) {
      parts.push(`${exchange} failed: ${(e as Error).message}`);
    }
  }
  if (done.length > 0) {
    const newKeys = await rekeyExchangeHoldings(done);
    if (newKeys.length > 0) await ensureAssetPrices(newKeys, "exchange-mappings");
    parts.push(`${newKeys.length} holdings' coins changed`);
  }
  return parts.join("; ");
}

let running: Promise<string> | null = null;

/** Runs a pass when the last one is older than maxAgeMs. At most one runs
 * per server instance at a time. */
export async function refreshExchangeAssetsIfStale(maxAgeMs: number): Promise<string> {
  const { data, error } = await serviceDb()
    .from("exchange_assets")
    .select("updated_at")
    .eq("mapping_source", SOURCE)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to read exchange mappings: ${error.message}`);
  const last = data?.[0]?.updated_at ? Date.parse(data[0].updated_at as string) : 0;
  if (Date.now() - last < maxAgeMs) return "fresh";
  if (running) return "already running";
  running = refreshExchangeAssets().finally(() => {
    running = null;
  });
  return running;
}
