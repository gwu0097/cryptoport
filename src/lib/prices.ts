import "server-only";
import { serviceDb } from "./supabase";
import { fetchCoinbaseSpotPrice, fetchCoinbase24hChange, CoinbaseDelistedError } from "./coinbase";
import { fetchTokenInfo } from "./adapters/jupiter";
import { refreshEvmHoldingPrices } from "./adapters/multicallEvm";
import { mapWithConcurrency } from "./adapters/http";

// Coinbase's Exchange API host (used for the delisting check + 24h stats,
// see coinbase.ts) throttles hard under an unbounded burst — verified live
// that firing every distinct holding ticker's requests at once (previously
// a plain Promise.all here) got the large majority of /stats calls 429'd,
// even for perfectly ordinary, actively-traded tickers. This is the first
// of two mitigations (coinbase.ts's own retry-with-backoff is the second,
// for whatever still gets throttled through this).
const COINBASE_CONCURRENCY = 4;

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

async function upsertPrice(
  ticker: string,
  usd: string,
  source: "coinbase" | "jupiter",
  change24h: number | null,
) {
  const { error } = await serviceDb()
    .from("prices")
    .upsert({ ticker, usd, source, change_24h_pct: change24h, updated_at: new Date().toISOString() });
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
 *
 * Also runs refreshEvmHoldingPrices alongside the ticker-keyed refresh
 * above — EVM holdings are valued via usd_override, computed from
 * CoinGecko directly on the holding row, and otherwise only ever updated
 * by that wallet's own next full sync (see multicallEvm.ts). Composed here
 * rather than merged into the Coinbase/Jupiter logic since it's a genuinely
 * separate concern (per-holding usd_override, not the shared ticker
 * table) — this function's job is "make every known price fresh," however
 * many different mechanisms that takes.
 */
export async function refreshPrices(): Promise<PriceRefreshResult[]> {
  const holdingTickers = await getDistinctHoldingTickers();
  const existingSources = await getExistingPriceSources();

  const coinbaseResults = await mapWithConcurrency(
    holdingTickers,
    COINBASE_CONCURRENCY,
    async ({ ticker }): Promise<PriceRefreshResult> => {
      try {
        // 24h change is fetched alongside the spot price, not gated on it
        // succeeding — fetchCoinbase24hChange never throws (see its own
        // comment), so a failure there just means change24h is null this
        // cycle, not a failed refresh.
        const [usd, change24h] = await Promise.all([
          fetchCoinbaseSpotPrice(ticker),
          fetchCoinbase24hChange(ticker),
        ]);
        await upsertPrice(ticker, usd, "coinbase", change24h);
        return { ticker, ok: true, usd };
      } catch (e) {
        return { ticker, ok: false, error: (e as Error).message, delisted: e instanceof CoinbaseDelistedError };
      }
    },
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
                await upsertPrice(ticker, usd, "jupiter", info.stats24h?.priceChange ?? null);
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
  const evmResults = await refreshEvmHoldingPrices();
  return [
    ...coinbaseResults.filter((r) => r.ok || !jupiterSucceeded.has(r.ticker)),
    ...jupiterResults,
    ...evmResults,
  ];
}
