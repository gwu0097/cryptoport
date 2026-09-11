import "server-only";
import { serviceDb } from "./supabase";
import { fetchCoinbaseSpotPrice, CoinbaseDelistedError } from "./coinbase";
import { fetchTokenInfo } from "./adapters/jupiter";

export interface PriceRefreshResult {
  ticker: string;
  ok: boolean;
  usd?: string;
  error?: string;
  /** Only meaningful when !ok — Coinbase itself confirmed this product is
   * permanently delisted, not just a transient failure. See the Jupiter-
   * fallback gate below for why this distinction matters. */
  delisted?: boolean;
}

interface HoldingTickerInfo {
  ticker: string;
  /** First non-null contract seen for this ticker across all holdings — a
   * ticker could in principle come from holdings with different contracts
   * (e.g. two different mints someone happened to label the same symbol);
   * this only matters for the Jupiter-fallback lookup below, not for
   * anything security- or money-sensitive, so "first seen" is fine. */
  contract: string | null;
}

// Prices are driven by holdings, not by adapters: every distinct ticker any
// holding uses needs a price, including BTC, which no adapter ever touches.
async function getDistinctHoldingTickers(): Promise<HoldingTickerInfo[]> {
  const { data, error } = await serviceDb().from("holdings").select("ticker, contract");
  if (error) throw new Error(`Failed to load holding tickers: ${error.message}`);

  const byTicker = new Map<string, string | null>();
  for (const row of data as { ticker: string; contract: string | null }[]) {
    if (!byTicker.has(row.ticker) || (!byTicker.get(row.ticker) && row.contract)) {
      byTicker.set(row.ticker, row.contract);
    }
  }
  return [...byTicker.entries()].map(([ticker, contract]) => ({ ticker, contract }));
}

async function getExistingPriceSources(): Promise<Map<string, string | null>> {
  const { data, error } = await serviceDb().from("prices").select("ticker, source");
  if (error) throw new Error(`Failed to load existing prices: ${error.message}`);
  return new Map((data as { ticker: string; source: string | null }[]).map((r) => [r.ticker, r.source]));
}

async function upsertPrice(ticker: string, usd: string, source: "coinbase" | "jupiter") {
  const { error } = await serviceDb()
    .from("prices")
    .upsert({ ticker, usd, source, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

/**
 * Refreshes the `prices` table from Coinbase (authoritative) and, only for
 * tickers Coinbase doesn't cover, Jupiter. Coinbase-sourced rows are never
 * overwritten by Jupiter — not just within one run, but across runs: a
 * ticker that has ever been priced by Coinbase stays Coinbase's even if
 * Coinbase happens to fail on some later refresh, because `prices.ticker`
 * is the primary key and a Solana spam token that happens to share a
 * symbol with a real asset (e.g. "BTC") would otherwise silently overwrite
 * that asset's real price. One ticker's failure never touches another's
 * (upsert, never wipe) — a ticker neither source can price keeps its
 * previous value and timestamp.
 *
 * One deliberate exception to "Coinbase's forever": a *confirmed* delisting
 * (CoinbaseDelistedError, not just any failure) does let Jupiter take over
 * — Coinbase's own v2 spot-price endpoint keeps serving a frozen last-trade
 * number for a delisted product with no "this is stale" signal in the
 * response itself (real bug found on JUP: showed $0.0003 instead of the
 * real ~$0.25 for months after Coinbase delisted it), so treating a
 * confirmed delisting the same as an ordinary transient failure would leave
 * that ticker permanently mispriced instead of ever recovering.
 */
export async function refreshPrices(): Promise<PriceRefreshResult[]> {
  const holdingTickers = await getDistinctHoldingTickers();
  const existingSources = await getExistingPriceSources();

  const coinbaseResults = await Promise.all(
    holdingTickers.map(async ({ ticker }): Promise<PriceRefreshResult> => {
      try {
        const usd = await fetchCoinbaseSpotPrice(ticker);
        await upsertPrice(ticker, usd, "coinbase");
        return { ticker, ok: true, usd };
      } catch (e) {
        return { ticker, ok: false, error: (e as Error).message, delisted: e instanceof CoinbaseDelistedError };
      }
    }),
  );

  const coinbaseFailedTickers = new Set(coinbaseResults.filter((r) => !r.ok).map((r) => r.ticker));
  const coinbaseDelistedTickers = new Set(
    coinbaseResults.filter((r) => !r.ok && r.delisted).map((r) => r.ticker),
  );
  const jupiterCandidates = holdingTickers.filter(
    (h) =>
      coinbaseFailedTickers.has(h.ticker) &&
      h.contract !== null &&
      (existingSources.get(h.ticker) !== "coinbase" || coinbaseDelistedTickers.has(h.ticker)),
  );

  const jupiterResults =
    jupiterCandidates.length === 0
      ? []
      : await (async (): Promise<PriceRefreshResult[]> => {
          const tokenInfo = await fetchTokenInfo(jupiterCandidates.map((c) => c.contract!));
          return Promise.all(
            jupiterCandidates.map(async ({ ticker, contract }): Promise<PriceRefreshResult> => {
              const info = tokenInfo.get(contract!);
              if (info?.usdPrice == null) {
                return { ticker, ok: false, error: "Jupiter has no price for this token." };
              }
              try {
                const usd = String(info.usdPrice);
                await upsertPrice(ticker, usd, "jupiter");
                return { ticker, ok: true, usd };
              } catch (e) {
                return { ticker, ok: false, error: (e as Error).message };
              }
            }),
          );
        })();

  // A ticker that succeeded via Jupiter shouldn't also be reported as a
  // Coinbase failure in the combined results.
  const jupiterSucceeded = new Set(jupiterResults.filter((r) => r.ok).map((r) => r.ticker));
  return [...coinbaseResults.filter((r) => r.ok || !jupiterSucceeded.has(r.ticker)), ...jupiterResults];
}
