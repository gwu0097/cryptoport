// Pure resolver, no DB, no network — turns a holding into the key
// coingecko.ts's fetchDailyHistory (and price_history's storage) uses to
// look up its historical price. Deliberately conservative: anything it
// can't resolve with real data comes back null, counted as "uncovered" by
// analytics.ts rather than guessed at (see CLAUDE.md's data-correctness
// rule — an estimate that silently drops a holding is honest; one that
// guesses at its identity isn't).

import { EVM_CHAINS } from "./adapters/evmChains.ts";
import { NON_EVM_CHAINS } from "./adapters/nonEvmChains.ts";
import { NON_EVM_PLATFORM_IDS, NATIVE_COINGECKO_IDS } from "./adapters/coingeckoIds.ts";
import type { HoldingSource } from "./types.ts";

// slug (holding.chain's own vocabulary, e.g. "solana") -> native ticker
// (e.g. "SOL") — derived from NON_EVM_CHAINS rather than hand-duplicated,
// so it can never drift from the one place that vocabulary is defined.
const NON_EVM_NATIVE_SYMBOLS: Record<string, string> = Object.fromEntries(
  NON_EVM_CHAINS.map((c) => [c.slug, c.id]),
);

export interface PriceKeyInput {
  ticker: string;
  source: HoldingSource;
  contract: string | null;
  chain: string | null;
}

function platformFor(chain: string): string | null {
  return EVM_CHAINS.find((c) => c.id === chain)?.coingeckoPlatform ?? NON_EVM_PLATFORM_IDS[chain] ?? null;
}

/**
 * `"<platform>:<contract>"` for anything with a contract address on a
 * chain this app knows CoinGecko's platform id for, `"<coin-id>"` for a
 * recognized native token, or null when neither applies — a manual
 * dollar-figure holding, a DeFi position with no priced-per-unit value, a
 * holding synced before the `chain` column existed (chain: null), or a
 * token/chain combination this app has no CoinGecko mapping for.
 *
 * The native-token fallback ONLY fires when the ticker actually matches
 * that chain's own native asset (checked against EVM_CHAINS' nativeSymbol
 * for EVM chains, NON_EVM_NATIVE_SYMBOLS for everything else) — a
 * contract-less holding on, say, the solana chain that isn't SOL itself
 * (a reward/LP token an adapter never resolved a mint for) must come back
 * null, not get priced as SOL. Skipping that check once priced a $0.02
 * Solana token at SOL's ~$100+ price, inflating one wallet by orders of
 * magnitude — see analytics.test.ts's regression test for the exact shape
 * of that bug.
 */
export function resolveCoingeckoKey(holding: PriceKeyInput): string | null {
  if (holding.source === "manual_usd") return null;

  if (holding.contract && holding.chain) {
    const platform = platformFor(holding.chain);
    if (platform) return `${platform}:${holding.contract.toLowerCase()}`;
  }

  if (!holding.chain) return null;

  const ticker = holding.ticker.toUpperCase();

  const evmChain = EVM_CHAINS.find((c) => c.id === holding.chain);
  if (evmChain) {
    return ticker === evmChain.nativeSymbol.toUpperCase() ? evmChain.nativeCoingeckoId : null;
  }

  const nativeSymbol = NON_EVM_NATIVE_SYMBOLS[holding.chain];
  if (nativeSymbol && ticker === nativeSymbol) {
    return NATIVE_COINGECKO_IDS[holding.chain] ?? null;
  }

  return null;
}
