import "server-only";
import type { Address } from "viem";
import { fetchEvmChainsHoldings } from "./multicallEvm";
import { fetchHyperliquidHoldings } from "./hyperliquid";
import { fetchAxieStaking } from "./axieStaking";
import { fetchPolymarketHoldings } from "./polymarket";
import { fetchSuperverseStaking } from "./superverseStaking";
import type { AdapterHolding } from "./types";
import { chainScope, protocolScope, type KeepScope } from "../carryForward";

export interface EvmHoldingsResult {
  holdings: AdapterHolding[];
  /** Non-fatal partial failures (e.g. one chain's public RPC had a bad
   * moment, or Hyperliquid's API was briefly down) — the sync still saves
   * whatever it did get. Empty when everything succeeded. */
  warnings: string[];
  /** Rows those failures left unanswered — the sync keeps them from the
   * previous run (carryForward.ts). */
  keep: KeepScope[];
}

/**
 * Direct on-chain reads (Multicall3 + a CoinGecko-derived token registry,
 * see multicallEvm.ts) across every chain in evmChains.ts, plus Hyperliquid
 * (spot + perps — a chain no on-chain balance read would ever see, since it
 * lives entirely inside Hyperliquid's own exchange, not a token contract).
 * No indexer dependency, no shared per-IP rate limit — an earlier version
 * of this adapter called Rabby's free API instead and rate-limited far
 * harder under real use than its own documentation suggested it would.
 *
 * Each chain (and Hyperliquid) fails independently rather than aborting the
 * whole sync — a free public RPC having a bad moment on one chain shouldn't
 * discard every other chain's correctly-read balances. Only throws if
 * literally everything failed, since a sync with zero data is worth
 * treating as a hard failure (leaves previous holdings untouched — see
 * syncWalletHoldings).
 */
export async function fetchEvmHoldings(address: string): Promise<EvmHoldingsResult> {
  // Every source but the chain scan is a soft failure: niche/narrow (most
  // EVM wallets never touched Ronin staking, Polymarket or SuperVerse),
  // same "one source's failure never discards another's correctly-fetched
  // data" rule as solDefiPositions.ts. A failed source's previous rows are
  // kept (its KeepScope, see carryForward.ts) instead of vanishing.
  const soft = <T,>(name: string, scope: KeepScope, p: Promise<T[]>) =>
    p.then(
      (holdings) => ({ holdings, warnings: [] as string[], keep: [] as KeepScope[] }),
      (e: Error) => ({ holdings: [] as T[], warnings: [`${name}: ${e.message}`], keep: [scope] }),
    );
  const [chainsResult, hyperliquidResult, ...others] = await Promise.all([
    fetchEvmChainsHoldings(address as Address),
    fetchHyperliquidHoldings(address).then(
      (r) => ({ ...r, error: null as string | null }),
      (e: Error) => ({
        holdings: [] as AdapterHolding[],
        warnings: [`hyperliquid: ${e.message}`],
        keep: [chainScope("hyperliquid", "hyperliquid")],
        error: e.message,
      }),
    ),
    soft("axie staking", protocolScope("axie staking", "Axie Staking"), fetchAxieStaking(address as Address)),
    soft("polymarket", chainScope("polymarket", "polymarket"), fetchPolymarketHoldings(address)),
    soft("superverse staking", protocolScope("superverse staking", "SuperVerse Staking"), fetchSuperverseStaking(address as Address)),
  ]);

  const holdings = [...chainsResult.holdings, ...hyperliquidResult.holdings, ...others.flatMap((o) => o.holdings)];
  const warnings = [
    ...chainsResult.failedChains.map((f) => `${f.chainId}: ${f.error}`),
    ...hyperliquidResult.warnings,
    ...others.flatMap((o) => o.warnings),
  ];
  const keep = [...chainsResult.keep, ...hyperliquidResult.keep, ...others.flatMap((o) => o.keep)];

  // Nothing succeeded anywhere and something actually went wrong badly
  // enough to distrust the whole result (a whole chain's fetch threw, or
  // Hyperliquid errored) — treat as a hard failure so syncWalletHoldings
  // leaves the wallet's previous holdings untouched instead of overwriting
  // them with an empty set. Deliberately NOT triggered by an
  // unverifiedCount-only warning (some individual balance-of calls flaky
  // after retries, but the chain's own fetch completed) — a wallet that's
  // genuinely empty on every chain used to get its correct "$0 here"
  // result thrown away just because one unrelated chain had a handful of
  // flaky token checks, which made it look like the sync failed outright
  // for a wallet that in fact synced correctly (real bug: found via a
  // wallet with a real, if dust-level, native balance that never made it
  // into holdings because of exactly this).
  const hardFailure = chainsResult.failedChains.some((f) => f.hard) || hyperliquidResult.error !== null;
  if (holdings.length === 0 && hardFailure) {
    throw new Error(`Every source failed: ${warnings.join("; ")}`);
  }

  return { holdings, warnings, keep };
}
