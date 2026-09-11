import "server-only";
import { fetchJupiterHoldings } from "./jupiter";
import { fetchSolDefiPositions } from "./solDefiPositions";
import { fetchCosmosHoldings, isCosmosAddress } from "./cosmos";
import { fetchSuiHoldings, isSuiAddress } from "./sui";
import { fetchFilecoinHoldings, isFilecoinAddress } from "./filecoin";
import { fetchBitcoinCashHoldings, isBitcoinCashAddress } from "./bitcoincash";
import { fetchNearHoldings, isNearAccountId } from "./near";
import { fetchSubstrateHoldings, isSubstrateAddress } from "./substrate";
import { fetchNeoHoldings, isNeoAddress } from "./neo";
import { fetchXrpHoldings, isXrpAddress } from "./xrp";
import { fetchTonHoldings, isTonAddress } from "./ton";
import { fetchAptosHoldings } from "./aptos";
import { fetchIcpHoldings } from "./icp";
import type { AdapterHolding } from "./types";

export interface AdapterFetchResult {
  holdings: AdapterHolding[];
  /** Partial, non-fatal failures — see wallets/actions.ts's own doc
   * comment on this same shape. Only Solana ever populates this today
   * (via its DeFi-position fetch); every other entry below always returns
   * an empty array, same as before this table existed. */
  warnings: string[];
}

interface NonEvmDispatchEntry {
  fetch: (address: string) => Promise<AdapterFetchResult>;
  /** Blind address-format detection, for the "search any address" lookup
   * feature (lookup.ts) — omitted for chains with no reliable way to tell
   * their address format apart from others sharing the same shape: TAO
   * shares Substrate's generic SS58 prefix with dozens of chains (DOT's
   * prefix is unique enough to trust, TAO's isn't); APT and ICP are both
   * bare hex indistinguishable from other chains' addresses (and from
   * each other/EVM in APT's case). A wallet's explicit chain label is the
   * only reliable way to know which of these three to use. */
  detect?: (address: string) => boolean;
}

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function simple(fn: (address: string) => Promise<AdapterHolding[]>): NonEvmDispatchEntry["fetch"] {
  return async (address) => ({ holdings: await fn(address), warnings: [] });
}

/**
 * One dispatch table for every non-EVM, non-BTC/ADA/SEI chain this app has
 * an adapter for — the single source both syncWalletHoldings
 * (wallets/actions.ts) and the "search any address" lookup feature
 * (lookup.ts) draw from, replacing what used to be two independently
 * hand-maintained if/ternary ladders (one per file, different styles) that
 * every new adapter had to be wired into by hand, twice.
 *
 * BTC and ADA are deliberately excluded: both need extra cached state
 * threaded through (script type, stake address) that doesn't fit this
 * table's plain "address in, holdings out" shape, so they stay as bespoke
 * calls at each call site, same as before this table existed. SEI is
 * excluded for a different reason — its address format alone is ambiguous
 * between this table's Cosmos-native adapter and the generic EVM path
 * (evm.ts, via isEvmChainId), so it has to be disambiguated before this
 * table is even consulted; see the dedicated SEI check at each call site.
 */
export const NON_EVM_DISPATCH: Record<string, NonEvmDispatchEntry> = {
  SOL: {
    fetch: async (address) => {
      const [tokenHoldings, positions] = await Promise.all([
        fetchJupiterHoldings(address),
        fetchSolDefiPositions(address),
      ]);
      return { holdings: [...tokenHoldings, ...positions.holdings], warnings: positions.warnings };
    },
    detect: (address) => SOLANA_ADDRESS_RE.test(address),
  },
  ATOM: {
    fetch: simple((address) => fetchCosmosHoldings("ATOM", address)),
    detect: (address) => isCosmosAddress("ATOM", address),
  },
  INJ: {
    fetch: simple((address) => fetchCosmosHoldings("INJ", address)),
    detect: (address) => isCosmosAddress("INJ", address),
  },
  SUI: {
    fetch: simple(fetchSuiHoldings),
    detect: isSuiAddress,
  },
  FIL: {
    fetch: simple(fetchFilecoinHoldings),
    detect: isFilecoinAddress,
  },
  BCH: {
    fetch: simple(fetchBitcoinCashHoldings),
    detect: isBitcoinCashAddress,
  },
  NEAR: {
    fetch: simple(fetchNearHoldings),
    detect: isNearAccountId,
  },
  DOT: {
    fetch: simple((address) => fetchSubstrateHoldings("DOT", address)),
    detect: (address) => isSubstrateAddress("DOT", address),
  },
  TAO: {
    fetch: simple((address) => fetchSubstrateHoldings("TAO", address)),
    // no detect — see NonEvmDispatchEntry's doc comment above.
  },
  NEO: {
    fetch: simple(fetchNeoHoldings),
    detect: isNeoAddress,
  },
  XRP: {
    fetch: simple(fetchXrpHoldings),
    detect: isXrpAddress,
  },
  TON: {
    fetch: simple(fetchTonHoldings),
    detect: isTonAddress,
  },
  APT: {
    fetch: simple(fetchAptosHoldings),
    // no detect — see NonEvmDispatchEntry's doc comment above.
  },
  ICP: {
    fetch: simple(fetchIcpHoldings),
    // no detect — see NonEvmDispatchEntry's doc comment above.
  },
};

/** The chain id (a NON_EVM_CHAINS.id, e.g. "SOL") of the first entry (in
 * table declaration order) whose detect() matches, or undefined. Object
 * key order follows declaration order for string keys, same order
 * lookup.ts's old ladder checked in — preserved for parity, though address
 * formats are mutually exclusive by construction (each detect() already
 * has to be narrow enough not to false-positive on another chain's
 * address), so check order doesn't actually change the result. */
export function detectNonEvmChain(address: string): string | undefined {
  for (const [id, entry] of Object.entries(NON_EVM_DISPATCH)) {
    if (entry.detect?.(address)) return id;
  }
  return undefined;
}
