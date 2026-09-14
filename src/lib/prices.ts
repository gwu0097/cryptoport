import "server-only";
import { serviceDb } from "./supabase";
import { fetchCoinbaseSpotPrice, fetchCoinbase24hChange, CoinbaseDelistedError } from "./coinbase";
import { fetchTokenInfo } from "./adapters/jupiter";
import { refreshEvmHoldingPrices } from "./adapters/multicallEvm";
import { fetchTokenPrices, fetchNativePrices } from "./adapters/coingecko";
import { EVM_CHAINS } from "./adapters/evmChains";
import { resolveCoingeckoKey } from "./priceKey";
import { mapWithConcurrency } from "./adapters/http";
import type { HoldingSource } from "./types";

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

interface HoldingTickerInfo {
  ticker: string;
  /** First non-null contract seen for this ticker across all holdings — a
   * ticker could in principle come from holdings with different contracts
   * (e.g. two different mints someone happened to label the same symbol);
   * this only matters for the Jupiter-fallback lookup below, not for
   * anything security- or money-sensitive, so "first seen" is fine. */
  contract: string | null;
  /** Same "first non-null seen" reasoning as contract — needed to resolve
   * a CoinGecko key (contract+chain, or chain-native-symbol match). */
  chain: string | null;
  /** Plain first-seen, no null-preference — only used to skip manual_usd
   * tickers in the CoinGecko resolution step below. Getting this "wrong"
   * (picking a non-manual source when a manual holding shares the ticker)
   * only means a ticker that could have resolved via CoinGecko falls back
   * to Coinbase instead — never a wrong number, so it doesn't need
   * contract/chain's more careful merge logic. */
  source: string;
}

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
  const { data, error } = await serviceDb().from("holdings").select("ticker, contract, chain, source");
  if (error) throw new Error(`Failed to load holding tickers: ${error.message}`);

  const rows = data as { ticker: string; contract: string | null; chain: string | null; source: string }[];
  const byTicker = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker)!.push(row);
  }

  const result: HoldingTickerInfo[] = [];
  for (const [ticker, group] of byTicker) {
    const nativeMatch = group.find((r) => {
      if (r.contract !== null || r.chain === null) return false;
      const key = resolveCoingeckoKey({ ticker, source: r.source as HoldingSource, contract: null, chain: r.chain });
      return key !== null && !key.includes(":");
    });
    const contractRow = group.find((r) => r.contract !== null);
    const fallbackRow = group.find((r) => r.chain !== null) ?? group[0];
    const representative = nativeMatch ?? contractRow ?? fallbackRow;
    result.push({
      ticker,
      contract: nativeMatch ? null : (contractRow?.contract ?? null),
      chain: representative.chain,
      source: group[0].source,
    });
  }
  return result;
}

async function getExistingPriceSources(): Promise<Map<string, string | null>> {
  const { data, error } = await serviceDb().from("prices").select("ticker, source");
  if (error) throw new Error(`Failed to load existing prices: ${error.message}`);
  return new Map((data as { ticker: string; source: string | null }[]).map((r) => [r.ticker, r.source]));
}

const EVM_COINGECKO_PLATFORMS = new Set(EVM_CHAINS.map((c) => c.coingeckoPlatform));

async function upsertPrice(
  ticker: string,
  usd: string,
  source: "coingecko" | "coinbase" | "jupiter",
  change24h: number | null,
  marketCap?: number | null,
) {
  const row: { ticker: string; usd: string; source: string; change_24h_pct: number | null; updated_at: string; market_cap?: number | null } = {
    ticker,
    usd,
    source,
    change_24h_pct: change24h,
    updated_at: new Date().toISOString(),
  };
  // Omitted (not set to null) for coinbase/jupiter — a partial-column
  // upsert only ever touches the columns actually given (same behavior
  // multicallEvm.ts's saveDecimals/saveImageUrls/saveChange24h already
  // rely on for token_registry), so a ticker's market cap from an earlier
  // CoinGecko-sourced cycle survives a later Coinbase/Jupiter refresh
  // instead of being wiped to null just because those sources don't know
  // market cap at all.
  if (marketCap !== undefined) row.market_cap = marketCap;
  const { error } = await serviceDb().from("prices").upsert(row);
  if (error) throw new Error(error.message);
}

interface ResolvedTicker {
  ticker: string;
  key: string; // "<platform>:<contract>" or a bare coingecko id
}

/**
 * Splits every distinct holding ticker into: resolvable via CoinGecko
 * (a real, collision-safe key — see priceKey.ts's resolveCoingeckoKey)
 * vs. residual (no safe key — old/manual holdings with no chain hint to
 * disambiguate by). Pure, synchronous, no network call — which is what
 * lets the CoinGecko pass and the Coinbase/Jupiter residual pass below
 * start in true parallel rather than one waiting to learn what the other
 * needs to attempt.
 */
function splitByCoingeckoResolvability(tickers: HoldingTickerInfo[]): {
  resolved: ResolvedTicker[];
  residual: HoldingTickerInfo[];
} {
  const resolved: ResolvedTicker[] = [];
  const residual: HoldingTickerInfo[] = [];
  for (const t of tickers) {
    if (t.source === "manual_usd") {
      residual.push(t);
      continue;
    }
    const key = resolveCoingeckoKey({ ticker: t.ticker, source: t.source as HoldingSource, contract: t.contract, chain: t.chain });
    if (key) resolved.push({ ticker: t.ticker, key });
    else residual.push(t);
  }
  return { resolved, residual };
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
        const prices = await fetchNativePrices([...nativeIds.keys()]);
        await Promise.all(
          [...nativeIds].map(async ([id, ticker]) => {
            const price = prices.get(id);
            if (!price) {
              results.push({ ticker, ok: false, error: "No CoinGecko price for this native asset." });
              return;
            }
            const usd = String(price.usd);
            await upsertPrice(ticker, usd, "coingecko", price.change24h, price.marketCap);
            results.push({ ticker, ok: true, usd });
          }),
        );
      })(),
    );
  }

  for (const [platform, entries] of contractsByPlatform) {
    lanes.push(
      (async () => {
        const prices = await fetchTokenPrices(platform, entries.map((e) => e.contract));
        await Promise.all(
          entries.map(async ({ ticker, contract }) => {
            const price = prices.get(contract.toLowerCase());
            if (!price) {
              if (platform === "solana") solanaMisses.push({ ticker, contract });
              else results.push({ ticker, ok: false, error: "No CoinGecko price for this contract." });
              return;
            }
            const usd = String(price.usd);
            await upsertPrice(ticker, usd, "coingecko", price.change24h, price.marketCap);
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
type PhaseName = "coingecko" | "coinbase" | "evm";
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
export async function refreshPrices(startedAt: number = Date.now()): Promise<PriceRefreshResult[]> {
  const holdingTickers = await getDistinctHoldingTickers();
  const existingSources = await getExistingPriceSources();
  const { resolved, residual } = splitByCoingeckoResolvability(holdingTickers);

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
  // PriceRefreshCaption) can show real progress: which lane is still
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
  };
  await persistPhases(phases);

  async function tracked<T>(name: PhaseName, work: Promise<T>): Promise<T> {
    try {
      const result = await work;
      phases[name] = { status: "done", ms: Date.now() - t0 };
      await persistPhases(phases);
      return result;
    } catch (e) {
      phases[name] = { status: "error", ms: Date.now() - t0 };
      await persistPhases(phases);
      throw e;
    }
  }

  // "coinbase" is deliberately NOT wrapped in tracked() — real bug, caught
  // live: the initial residual call finishing would mark it "done" at,
  // say, 2.2s, then the Solana-miss follow-up below (still to come) would
  // silently overwrite that same "done" a second time at 7.6s once it
  // finished — showing a lane as complete, then un-completing and
  // re-completing it, which read as broken rather than as one lane taking
  // a while. The phase only gets its one "done" write below, once the
  // whole thing (both steps) is actually finished.
  const [coingecko, coinbaseAndJupiter, evmResults] = await Promise.all([
    tracked("coingecko", refreshCoinGeckoTickers(resolved)),
    refreshCoinbaseAndJupiter(residual, existingSources),
    tracked("evm", refreshEvmHoldingPrices()),
  ]);
  const { coinbaseResults, jupiterResults } = coinbaseAndJupiter;

  // Small, second-stage follow-up for Solana contracts CoinGecko didn't
  // have a price for — see refreshCoinGeckoTickers' own doc comment for
  // why this can't be known until after that call returns, and refreshPrices'
  // own doc comment for why that's an acceptable, small sequential tail
  // rather than something worth restructuring further.
  let solanaMissResults: { coinbaseResults: PriceRefreshResult[]; jupiterResults: PriceRefreshResult[] } = {
    coinbaseResults: [],
    jupiterResults: [],
  };
  if (coingecko.solanaMisses.length > 0) {
    const solanaMissTickers: HoldingTickerInfo[] = coingecko.solanaMisses.map((m) => ({
      ticker: m.ticker,
      contract: m.contract,
      chain: "solana",
      source: "auto",
    }));
    solanaMissResults = await refreshCoinbaseAndJupiter(solanaMissTickers, existingSources);
  }
  phases.coinbase = { status: "done", ms: Date.now() - t0 };
  await persistPhases(phases);

  // A ticker that succeeded via Jupiter shouldn't also be reported as a
  // Coinbase failure in the combined results.
  const allJupiterResults = [...jupiterResults, ...solanaMissResults.jupiterResults];
  const jupiterSucceeded = new Set(allJupiterResults.filter((r) => r.ok).map((r) => r.ticker));

  return [
    ...coingecko.results,
    ...[...coinbaseResults, ...solanaMissResults.coinbaseResults].filter(
      (r) => r.ok || !jupiterSucceeded.has(r.ticker),
    ),
    ...allJupiterResults,
    ...evmResults,
  ];
}
