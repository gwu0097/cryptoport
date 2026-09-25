import "server-only";
import { serviceDb } from "./supabase.ts";
import { fetchCoinbaseSpotPrice, fetchCoinbase24hChange, CoinbaseDelistedError } from "./coinbase.ts";
import { fetchTokenInfo } from "./adapters/jupiter.ts";
import { refreshEvmHoldingPrices } from "./adapters/multicallEvm.ts";
import { refreshCosmosHoldingPrices } from "./adapters/cosmosMulti.ts";
import { fetchTokenPrices, fetchMarketStatsByIds } from "./adapters/coingecko.ts";
import { EVM_CHAINS } from "./adapters/evmChains.ts";
import { isFresh, SYNC_PRICE_MAX_AGE_MS } from "./priceCache.ts";
import { mapWithConcurrency } from "./adapters/http.ts";
import { getExchangeAssetRegistry } from "./exchangeAssetRegistry.ts";

// Coinbase's Exchange API host (used for the delisting check + 24h stats,
// see coinbase.ts) throttles hard under an unbounded burst — verified live
// that firing every distinct holding ticker's requests at once (previously
// a plain Promise.all here) got the large majority of /stats calls 429'd,
// even for perfectly ordinary, actively-traded tickers. This is the first
// of two mitigations (coinbase.ts's own retry-with-backoff is the second,
// for whatever still gets throttled through this). Matters much less now
// that Coinbase only ever sees the residual tickers CoinGecko couldn't
// safely resolve (see refreshPrices' own doc comment) — but the cap stays,
// since that residual set's exact size varies run to run.
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

// HoldingTickerInfo/tickerNeedsPricing/ResolvedTicker/
// splitByCoingeckoResolvability all live in priceResolution.ts now — pure
// logic, no DB/network, directly unit-testable separate from this file's
// own heavy import graph (Supabase, Coinbase, Jupiter, EVM adapters), which
// pulls in things (next/headers, via supabase.ts) that can't even load
// under a plain `node --test` process. Re-exported here so existing
// importers of `HoldingTickerInfo` from "@/lib/prices" (wallets/actions.ts)
// are unaffected.
export type { HoldingTickerInfo, ResolvedTicker } from "./priceResolution.ts";
export { tickerNeedsPricing, splitByCoingeckoResolvability } from "./priceResolution.ts";
import {
  tickerInfoFor,
  splitByCoingeckoResolvability,
  type HoldingTickerInfo,
  type ResolvedTicker,
} from "./priceResolution.ts";

// Prices are driven by holdings, not by adapters: every distinct ticker any
// holding uses needs a price, including BTC, which no adapter ever touches.
//
// A row that genuinely resolves to a native (chain-verified) CoinGecko key
// is always the correct representative for a ticker when one exists among
// its holdings, even if some other holding under that same ticker happens
// to have a contract — real bug, caught live: "ETH" stopped getting any
// ticker-table price at all once one Scroll holding's own contract (a
// bridged ETH representation, distinct from native ETH) won the previous
// "first non-null contract seen" merge over 68 other plain native-ETH
// holdings across other chains. That made the whole ticker resolve as a
// Scroll-contract lookup — which the CoinGecko pass correctly skips (EVM
// contract tokens are priced via usd_override, not the ticker table — see
// refreshCoinGeckoTickers), so "ETH" fell into neither lane and just went
// stale. Same live-verified for SOL, USDC, MNT, and POL — every ticker
// that has both native and contract-based holdings.
//
// Checked via resolveCoingeckoKey itself, not just "contract is null" —
// a null-contract row only counts as the strong native representative if
// it actually resolves to a bare (non-colon) key; a contract-less manual
// USDC entry, say, doesn't (USDC isn't any chain's native asset), so it
// must not force the group away from a real contract-based resolution
// that would otherwise work fine.
async function getDistinctHoldingTickers(): Promise<HoldingTickerInfo[]> {
  const { data, error } = await serviceDb()
    .from("holdings")
    .select("ticker, contract, chain, source, coingecko_id, usd_override");
  if (error) throw new Error(`Failed to load holding tickers: ${error.message}`);

  const rows = data as {
    ticker: string;
    contract: string | null;
    chain: string | null;
    source: string;
    coingecko_id: string | null;
    usd_override: string | number | null;
  }[];
  const byTicker = new Map<string, typeof rows>();
  for (const row of rows) {
    // Priced by their own CoinGecko id instead (refreshCosmosHoldingPrices).
    if (row.source === "auto_cosmos") continue;
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker)!.push(row);
  }

  // Only tickers some holding needs a ticker-keyed price for (every other
  // row is priced by its own usd_override — e.g. a DeFi position valued by
  // its protocol math at sync time), priced through a row that needs it
  // (priceResolution.ts's tickerInfoFor).
  const result: HoldingTickerInfo[] = [];
  for (const [ticker, group] of byTicker) {
    const info = tickerInfoFor(ticker, group);
    if (info) result.push(info);
  }
  return result;
}

async function getExistingPriceSources(): Promise<Map<string, string | null>> {
  const { data, error } = await serviceDb().from("prices").select("ticker, source");
  if (error) throw new Error(`Failed to load existing prices: ${error.message}`);
  return new Map((data as { ticker: string; source: string | null }[]).map((r) => [r.ticker, r.source]));
}

async function getExistingPriceSourcesFor(tickers: string[]): Promise<Map<string, string | null>> {
  if (tickers.length === 0) return new Map();
  const { data, error } = await serviceDb().from("prices").select("ticker, source").in("ticker", tickers);
  if (error) throw new Error(`Failed to load existing prices: ${error.message}`);
  return new Map((data as { ticker: string; source: string | null }[]).map((r) => [r.ticker, r.source]));
}

const EVM_COINGECKO_PLATFORMS = new Set(EVM_CHAINS.map((c) => c.coingeckoPlatform));

async function upsertPrice(
  ticker: string,
  usd: string,
  source: "coingecko" | "coinbase" | "jupiter",
  change24h: number | null,
  extra?: { marketCap?: number | null; change1h?: number | null; change7d?: number | null; change30d?: number | null },
) {
  const row: {
    ticker: string;
    usd: string;
    source: string;
    change_24h_pct: number | null;
    updated_at: string;
    market_cap?: number | null;
    change_1h_pct?: number | null;
    change_7d_pct?: number | null;
    change_30d_pct?: number | null;
  } = {
    ticker,
    usd,
    source,
    change_24h_pct: change24h,
    updated_at: new Date().toISOString(),
  };
  // Omitted (not set to null) for coinbase/jupiter, and for CoinGecko's
  // contract-keyed lane (simple/token_price caps out at 24h change, no
  // 1h/7d/30d — see fetchMarketStatsByIds' own doc comment) — a
  // partial-column upsert only ever touches the columns actually given
  // (same behavior multicallEvm.ts's saveDecimals/saveImageUrls/
  // saveMarketStats already rely on for token_registry), so a ticker's
  // market cap/multi-window change from an earlier CoinGecko-markets
  // cycle survives a later refresh from a source that doesn't know those
  // fields at all, instead of being wiped to null.
  if (extra?.marketCap !== undefined) row.market_cap = extra.marketCap;
  if (extra?.change1h !== undefined) row.change_1h_pct = extra.change1h;
  if (extra?.change7d !== undefined) row.change_7d_pct = extra.change7d;
  if (extra?.change30d !== undefined) row.change_30d_pct = extra.change30d;
  const { error } = await serviceDb().from("prices").upsert(row);
  if (error) throw new Error(error.message);
}

/**
 * Primary ticker price source. CoinGecko is used here — unlike Coinbase/
 * Jupiter, which key on a bare ticker symbol — only via a key already tied
 * to a real contract or a verified chain-native match, so it can never
 * price a ticker off an unrelated asset that happens to share its symbol
 * (see CLAUDE.md's Solana ticker-collision gap, the exact bug this
 * sidesteps). Batched — up to 100 ids/contracts per call with a key —
 * which is the entire reason this is fast: Coinbase's API is one ticker
 * per call with no batch endpoint at all, so what used to be a 27-second,
 * 156-round-trip pass becomes a small handful of calls.
 *
 * EVM contract-based tickers are deliberately skipped (`platform in
 * EVM_COINGECKO_PLATFORMS`): those holdings are priced via usd_override
 * directly on the holding row (multicallEvm.ts), which already fetches
 * this exact CoinGecko data for free as part of its own sync/refresh —
 * writing it again into the ticker table too would be pure waste, not a
 * correctness issue (a holding with usd_override set never consults the
 * ticker-keyed prices table at all — see valuation.ts).
 *
 * Solana contract-based tickers CoinGecko doesn't have a price for are
 * returned in `solanaMisses` rather than just marked failed — CoinGecko is
 * a curated database that doesn't list every SPL token; Jupiter prices
 * anything with real on-chain liquidity, which is exactly the long tail
 * CoinGecko misses, so those get a second chance through the residual
 * Coinbase/Jupiter pass. No other platform gets this treatment: Jupiter
 * has no data for a non-Solana contract, so there'd be nothing to fall
 * through to.
 *
 * Each platform's batch (native ids, and each contract platform) runs
 * concurrently and writes to `prices` the moment its own data lands —
 * real prices show up within a couple of seconds of a refresh starting,
 * not after every source finishes.
 */
async function refreshCoinGeckoTickers(
  resolved: ResolvedTicker[],
): Promise<{ results: PriceRefreshResult[]; solanaMisses: { ticker: string; contract: string }[] }> {
  const results: PriceRefreshResult[] = [];
  const solanaMisses: { ticker: string; contract: string }[] = [];

  const nativeIds = new Map<string, string>(); // coingecko id -> ticker
  const contractsByPlatform = new Map<string, { ticker: string; contract: string }[]>();

  for (const { ticker, key } of resolved) {
    const colon = key.indexOf(":");
    if (colon === -1) {
      nativeIds.set(key, ticker);
    } else {
      const platform = key.slice(0, colon);
      if (EVM_COINGECKO_PLATFORMS.has(platform)) continue; // priced via usd_override instead, see doc comment above
      const contract = key.slice(colon + 1);
      if (!contractsByPlatform.has(platform)) contractsByPlatform.set(platform, []);
      contractsByPlatform.get(platform)!.push({ ticker, contract });
    }
  }

  const lanes: Promise<void>[] = [];

  if (nativeIds.size > 0) {
    lanes.push(
      (async () => {
        const prices = await fetchMarketStatsByIds([...nativeIds.keys()]);
        await Promise.all(
          [...nativeIds].map(async ([id, ticker]) => {
            const price = prices.get(id);
            if (!price) {
              results.push({ ticker, ok: false, error: "No CoinGecko price for this native asset." });
              return;
            }
            const usd = String(price.usd);
            await upsertPrice(ticker, usd, "coingecko", price.change24h, {
              marketCap: price.marketCap,
              change1h: price.change1h,
              change7d: price.change7d,
              change30d: price.change30d,
            });
            results.push({ ticker, ok: true, usd });
          }),
        );
      })(),
    );
  }

  for (const [platform, entries] of contractsByPlatform) {
    lanes.push(
      (async () => {
        // 1h/7d/30d change, Solana only — simple/token_price (below) only
        // ever returns 24h change, confirmed live, same limitation the EVM
        // contract-token path has. Reported directly: these are real,
        // fully-listed CoinGecko assets, priced via a different endpoint
        // than /coins/markets for balance/liquidity reasons, not because
        // CoinGecko lacks the data — so this resolves each mint to its
        // coingecko_id via token_registry (refreshTokenRegistry's own
        // Solana loop populates this, same coins/list response the EVM
        // loop already uses) and fetches the extra windows the same way
        // multicallEvm.ts does for EVM contracts.
        //
        // Run via Promise.all alongside fetchTokenPrices below, NOT
        // awaited before it — see multicallEvm.ts's own doc comment for
        // the exact regression this shape avoids (an earlier version of
        // this awaited the lookup sequentially, ahead of the real pricing
        // call, extending every refresh's wall-clock time and, with it,
        // how long client-side navigation stays vulnerable to colliding
        // with a JobPoller-triggered router.refresh()). Best-effort: a
        // failure here shouldn't fail the actual price refresh below.
        const fetchSolanaMultiWindow = async (): Promise<
          Map<string, { change1h: number | null; change7d: number | null; change30d: number | null }>
        > => {
          if (platform !== "solana") return new Map();
          try {
            const { data } = await serviceDb()
              .from("token_registry")
              .select("contract, coingecko_id")
              .eq("chain_id", "solana")
              .in("contract", entries.map((e) => e.contract.toLowerCase()))
              .not("coingecko_id", "is", null);
            const registryRows = (data ?? []) as { contract: string; coingecko_id: string }[];
            const coingeckoIdByContract = new Map(registryRows.map((r) => [r.contract, r.coingecko_id]));
            const distinctIds = [...new Set(coingeckoIdByContract.values())];
            if (distinctIds.length === 0) return new Map();
            const marketStats = await fetchMarketStatsByIds(distinctIds);
            const result = new Map<string, { change1h: number | null; change7d: number | null; change30d: number | null }>();
            for (const [contract, coingeckoId] of coingeckoIdByContract) {
              const stats = marketStats.get(coingeckoId);
              if (stats) {
                result.set(contract, { change1h: stats.change1h, change7d: stats.change7d, change30d: stats.change30d });
              }
            }
            return result;
          } catch {
            return new Map();
          }
        };

        const [prices, multiWindowByContract] = await Promise.all([
          fetchTokenPrices(platform, entries.map((e) => e.contract)),
          fetchSolanaMultiWindow(),
        ]);
        await Promise.all(
          entries.map(async ({ ticker, contract }) => {
            const price = prices.get(contract.toLowerCase());
            if (!price) {
              if (platform === "solana") solanaMisses.push({ ticker, contract });
              else results.push({ ticker, ok: false, error: "No CoinGecko price for this contract." });
              return;
            }
            const usd = String(price.usd);
            const multiWindow = multiWindowByContract.get(contract.toLowerCase());
            await upsertPrice(ticker, usd, "coingecko", price.change24h, {
              marketCap: price.marketCap,
              ...multiWindow,
            });
            results.push({ ticker, ok: true, usd });
          }),
        );
      })(),
    );
  }

  await Promise.all(lanes);
  return { results, solanaMisses };
}

/** Residual source #1 (Coinbase, ticker-keyed) and #2 (Jupiter, only for
 * Coinbase failures with a contract) — unchanged from before this
 * refactor except for *which* tickers reach it: previously every distinct
 * holding ticker (up to 156, most of which Coinbase doesn't even list —
 * see refreshPrices' own doc comment), now only ones CoinGecko couldn't
 * safely resolve at all, plus (in a second, smaller call — see
 * refreshPrices) Solana contracts CoinGecko doesn't list. Coinbase-sourced
 * rows are never overwritten by Jupiter — not just within one run, but
 * across runs: a ticker that has ever been priced by Coinbase stays
 * Coinbase's even if Coinbase happens to fail on some later refresh,
 * because `prices.ticker` is the primary key and a spam token that
 * happens to share a symbol with a real asset would otherwise silently
 * overwrite that asset's real price. One deliberate exception: a
 * *confirmed* delisting (CoinbaseDelistedError, not just any failure)
 * does let Jupiter take over — Coinbase's own v2 spot-price endpoint
 * keeps serving a frozen last-trade number for a delisted product with no
 * "this is stale" signal in the response itself (real bug found on JUP:
 * showed $0.0003 instead of the real ~$0.25 for months after Coinbase
 * delisted it).
 */
async function refreshCoinbaseAndJupiter(
  holdingTickers: HoldingTickerInfo[],
  existingSources: Map<string, string | null>,
): Promise<{ coinbaseResults: PriceRefreshResult[]; jupiterResults: PriceRefreshResult[] }> {
  if (holdingTickers.length === 0) return { coinbaseResults: [], jupiterResults: [] };

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

  return { coinbaseResults, jupiterResults };
}

/**
 * Shared tail for both refreshPrices (the full global refresh) and
 * refreshTickerPrices (its scoped, sync-chained sibling below): the small
 * second-stage Solana-miss follow-up (see refreshCoinGeckoTickers' own doc
 * comment for why this can only be known once that call returns) plus the
 * final result merge (a ticker that succeeded via Jupiter shouldn't also be
 * reported as a Coinbase failure). Extracted rather than duplicated once a
 * second caller needed the identical logic — same "two is the threshold"
 * rule as this codebase's other extractions.
 */
async function mergeCoingeckoAndResidualResults(
  coingecko: { results: PriceRefreshResult[]; solanaMisses: { ticker: string; contract: string }[] },
  coinbaseAndJupiter: { coinbaseResults: PriceRefreshResult[]; jupiterResults: PriceRefreshResult[] },
  existingSources: Map<string, string | null>,
): Promise<PriceRefreshResult[]> {
  const { coinbaseResults, jupiterResults } = coinbaseAndJupiter;

  let solanaMissResults: { coinbaseResults: PriceRefreshResult[]; jupiterResults: PriceRefreshResult[] } = {
    coinbaseResults: [],
    jupiterResults: [],
  };
  if (coingecko.solanaMisses.length > 0) {
    const solanaMissTickers: HoldingTickerInfo[] = coingecko.solanaMisses.map((m) => ({
      ticker: m.ticker,
      contract: m.contract,
      chain: "solana",
      coingeckoId: null,
      source: "auto",
    }));
    solanaMissResults = await refreshCoinbaseAndJupiter(solanaMissTickers, existingSources);
  }

  const allJupiterResults = [...jupiterResults, ...solanaMissResults.jupiterResults];
  const jupiterSucceeded = new Set(allJupiterResults.filter((r) => r.ok).map((r) => r.ticker));

  return [
    ...coingecko.results,
    ...[...coinbaseResults, ...solanaMissResults.coinbaseResults].filter(
      (r) => r.ok || !jupiterSucceeded.has(r.ticker),
    ),
    ...allJupiterResults,
  ];
}

/**
 * Prices a specific, caller-supplied set of tickers instead of every
 * distinct ticker any holding anywhere uses — e.g. one wallet's own
 * holdings right after a sync. `refreshPrices` below is the right default
 * for the manual "Refresh prices" button (prices are shared, so scoping
 * that one doesn't isolate anything — see refreshPricesForWalletAction's
 * own doc comment in wallets/actions.ts), but the wrong size to chain into
 * every sync: a 10-token wallet doesn't need a ~9s global CoinGecko/
 * Coinbase pass, and syncAllWallets firing N of those in parallel would be
 * real, avoidable load. Reuses the exact same CoinGecko/Coinbase/Jupiter
 * lanes and source-precedence rules as refreshPrices (never a second,
 * parallel pricing implementation) — just without its EVM lane (the sync
 * that calls this already stamped fresh usd_override on its own EVM
 * holdings, see multicallEvm.ts) and without touching price_refresh_state
 * at all: no CAS claim (this isn't "the" refresh — many of these can run
 * concurrently across different wallets/users with no contention), no
 * phase tracking, and deliberately no bump to its global `refreshed_at` —
 * a scoped fill making the global "Last priced" caption claim everything
 * is fresh when only a few tickers were touched would be exactly the
 * misleading-staleness-number the Data Correctness rule forbids.
 */
export async function refreshTickerPrices(requested: HoldingTickerInfo[]): Promise<PriceRefreshResult[]> {
  // A ticker priced in the last few minutes (by another wallet's sync, or
  // Refresh prices) isn't asked again — five Solana wallets syncing in a
  // row used to price SOL five times (priceCache.ts).
  const distinct = [...new Set(requested.map((t) => t.ticker))];
  const { data: priced } = distinct.length
    ? await serviceDb().from("prices").select("ticker, usd, updated_at").in("ticker", distinct)
    : { data: [] };
  const now = Date.now();
  const recent = new Set(
    ((priced ?? []) as { ticker: string; usd: unknown; updated_at: string | null }[])
      .filter((r) => r.usd !== null && isFresh(r.updated_at, now, SYNC_PRICE_MAX_AGE_MS))
      .map((r) => r.ticker),
  );
  const tickers = requested.filter((t) => !recent.has(t.ticker));
  if (tickers.length === 0) return [];
  const [existingSources, exchangeRegistry] = await Promise.all([
    getExistingPriceSourcesFor([...new Set(tickers.map((t) => t.ticker))]),
    getExchangeAssetRegistry(),
  ]);
  const { resolved, residual } = splitByCoingeckoResolvability(tickers, exchangeRegistry);

  const [coingecko, coinbaseAndJupiter] = await Promise.all([
    refreshCoinGeckoTickers(resolved),
    refreshCoinbaseAndJupiter(residual, existingSources),
  ]);

  return mergeCoingeckoAndResidualResults(coingecko, coinbaseAndJupiter, existingSources);
}

/**
 * Refreshes every price this app tracks, from three sources with three
 * different jobs — not three competitors picked for speed, each fills a
 * gap the others structurally can't:
 *
 * 1. CoinGecko (refreshCoinGeckoTickers) — primary, for any ticker that
 *    resolves to a real, collision-safe key (contract+chain, or a
 *    verified chain-native match). Batched, so this covers the large
 *    majority of tickers in a couple of calls.
 * 2. Coinbase (inside refreshCoinbaseAndJupiter) — residual fallback for
 *    tickers with no safe CoinGecko key at all (old/manual holdings with
 *    no chain hint). A real exchange, trustworthy for the major coins
 *    this residual set is mostly made of.
 * 3. Jupiter — final fallback for (a) Coinbase failures with a contract,
 *    and (b) Solana contracts CoinGecko itself doesn't list (its curated
 *    database doesn't cover every SPL token the way Jupiter's on-chain-
 *    liquidity pricing does).
 *
 * All three run concurrently, not staged one after another — CoinGecko's
 * fast batched lane and Coinbase/Jupiter's slower per-ticker residual lane
 * have nothing for one to wait on from the other (the split between them
 * is computed locally, not from a network response — see
 * splitByCoingeckoResolvability), so real prices for most of a portfolio
 * land within a couple of seconds even while the residual lane is still
 * working through Coinbase's much smaller remaining set. The one
 * genuinely sequential piece left is Solana misses: those can only be
 * identified after CoinGecko's own Solana batch call returns, so they're
 * queued as a small follow-up Coinbase/Jupiter call rather than blocking
 * the initial parallel dispatch.
 *
 * Also runs refreshEvmHoldingPrices alongside all of the above — EVM
 * holdings are valued via usd_override, computed from CoinGecko directly
 * on the holding row, and otherwise only ever updated by that wallet's
 * own next full sync (see multicallEvm.ts). Composed here rather than
 * merged into the ticker-table logic since it's a genuinely separate
 * concern (per-holding usd_override, not the shared ticker table) — this
 * function's job is "make every known price fresh," however many
 * different mechanisms that takes.
 */
type PhaseName = "coingecko" | "coinbase" | "evm" | "cosmos";
type PhaseState = { status: "running" | "done" | "error"; ms: number | null };

/**
 * `startedAt` (epoch ms) lets a caller pass in when the refresh was really
 * requested — e.g. the moment refreshPricesAction started, before
 * requireUser(), the "mark refreshing" write, and the gap between a
 * Server Action returning and its after() callback actually beginning
 * (all real time, none of it visible in a t0 computed only once this
 * function's own body starts running). Defaults to "now" for a caller
 * (a diag script, a test) that doesn't have an earlier moment to anchor
 * to. Real user report this fixes: the per-lane timings (see phases
 * below) were reading noticeably shorter than the actual click-to-
 * updated-price time — because they were, structurally: every phase's
 * clock started only once this function's own body was already running,
 * which is itself downstream of all of the above.
 */
export async function refreshPrices(
  startedAt: number = Date.now(),
): Promise<{ results: PriceRefreshResult[]; laneErrors: string[] }> {
  const [holdingTickers, existingSources, exchangeRegistry] = await Promise.all([
    getDistinctHoldingTickers(),
    getExistingPriceSources(),
    getExchangeAssetRegistry(),
  ]);
  const { resolved, residual } = splitByCoingeckoResolvability(holdingTickers, exchangeRegistry);

  // Writes are queued (chained onto `writeQueue`), not fired independently
  // — three lanes finishing close together means three persistPhases calls
  // racing over the network, and without this, a later, more-complete
  // snapshot's response arriving before an earlier, less-complete one's
  // would get silently clobbered back to the stale state a moment later.
  // Queuing guarantees writes land in the order they were made, regardless
  // of individual request timing. Scoped locally to this one refreshPrices
  // call (not module-level) so two concurrent refreshes, if that ever
  // happens, don't serialize against each other. Best-effort — a write
  // failure here is purely cosmetic status reporting, never worth failing
  // the actual price refresh over.
  let writeQueue: Promise<void> = Promise.resolve();
  function persistPhases(phases: Record<PhaseName, PhaseState>): Promise<void> {
    const snapshot = { ...phases };
    writeQueue = writeQueue.then(async () => {
      try {
        await serviceDb().from("price_refresh_state").update({ phases: snapshot }).eq("id", 1);
      } catch {
        // swallowed — see doc comment
      }
    });
    return writeQueue;
  }

  // Live per-lane status, written to price_refresh_state.phases as each
  // lane actually finishes — not just recorded in memory and reported
  // once at the very end — so a page polling mid-refresh (see
  // PriceRefreshButton) can show real progress: which lane is still
  // running, which are done, and how long each one took. Timed from
  // `startedAt` (see this function's own doc comment for why that's not
  // just "now"), not per-lane, so "ms" reflects wall-clock elapsed since
  // the refresh was actually requested, comparable across lanes even
  // though they run concurrently.
  const t0 = startedAt;
  const phases: Record<PhaseName, PhaseState> = {
    coingecko: { status: "running", ms: null },
    coinbase: { status: "running", ms: null },
    evm: { status: "running", ms: null },
    cosmos: { status: "running", ms: null },
  };
  await persistPhases(phases);

  // Each lane fails on its own: a failed lane is recorded (phase "error" +
  // laneErrors) and the others finish. A lane error used to reject the
  // whole refresh at once — the status flipped to "error" while the EVM and
  // Coinbase lanes were still running (2026-09-25).
  const laneErrors: string[] = [];
  async function tracked<T>(name: PhaseName, work: Promise<T>, fallback: T, markDone = true): Promise<T> {
    try {
      const result = await work;
      if (markDone) {
        phases[name] = { status: "done", ms: Date.now() - t0 };
        await persistPhases(phases);
      }
      return result;
    } catch (e) {
      laneErrors.push(`${name}: ${(e as Error).message}`);
      phases[name] = { status: "error", ms: Date.now() - t0 };
      await persistPhases(phases);
      return fallback;
    }
  }

  // "coinbase" gets no "done" from its first step — real bug, caught live:
  // the initial residual call finishing would mark it "done" at, say, 2.2s,
  // then the Solana-miss follow-up below would overwrite that same "done"
  // again at 7.6s — a lane completing, un-completing and re-completing. Its
  // one "done" is written after the merge below (both steps).
  //
  // The Fallback lane's merge needs only the CoinGecko and Coinbase
  // results, so it runs as soon as those two are in — it used to wait for
  // every lane (the EVM one takes ~2 min), so "Fallback: running…" showed
  // for the whole refresh.
  const coingeckoLane = tracked("coingecko", refreshCoinGeckoTickers(resolved), { results: [], solanaMisses: [] });
  const fallbackLane = Promise.all([
    coingeckoLane,
    tracked("coinbase", refreshCoinbaseAndJupiter(residual, existingSources), null, false),
  ]).then(([coingecko, coinbaseAndJupiter]) =>
    coinbaseAndJupiter
      ? tracked("coinbase", mergeCoingeckoAndResidualResults(coingecko, coinbaseAndJupiter, existingSources), [])
      : coingecko.results,
  );
  const [merged, evmResults, cosmosResults] = await Promise.all([
    fallbackLane,
    tracked("evm", refreshEvmHoldingPrices(), []),
    // Cosmos multi-chain tokens: re-priced by their own CoinGecko id, same
    // idea as the EVM lane (adapters/cosmosMulti.ts).
    tracked("cosmos", refreshCosmosHoldingPrices(), []),
  ]);

  return { results: [...merged, ...evmResults, ...cosmosResults], laneErrors };
}
