import "server-only";
import { portfolioDb } from "./supabase";
import { fetchCoinbaseSpotPrice } from "./coinbase";

export interface PriceRefreshResult {
  ticker: string;
  ok: boolean;
  usd?: string;
  error?: string;
}

// Prices are driven by holdings, not by adapters: every distinct ticker any
// holding uses needs a price, including BTC, which no adapter ever touches.
async function getDistinctHoldingTickers(): Promise<string[]> {
  const { data, error } = await portfolioDb().from("holdings").select("ticker");
  if (error) throw new Error(`Failed to load holding tickers: ${error.message}`);
  return [...new Set((data as { ticker: string }[]).map((row) => row.ticker))];
}

/**
 * Refreshes the `prices` table from Coinbase for every ticker currently held.
 * One ticker's failure never touches another's row (upsert, never wipe) — a
 * ticker Coinbase can't price keeps its previous value and timestamp.
 */
export async function refreshPrices(): Promise<PriceRefreshResult[]> {
  const tickers = await getDistinctHoldingTickers();

  return Promise.all(
    tickers.map(async (ticker): Promise<PriceRefreshResult> => {
      try {
        const usd = await fetchCoinbaseSpotPrice(ticker);
        const { error } = await portfolioDb()
          .from("prices")
          .upsert({ ticker, usd, source: "coinbase", updated_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
        return { ticker, ok: true, usd };
      } catch (e) {
        return { ticker, ok: false, error: (e as Error).message };
      }
    }),
  );
}
