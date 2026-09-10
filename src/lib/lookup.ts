import "server-only";
import { fetchEvmHoldings } from "./adapters/evm";
import { fetchJupiterHoldings } from "./adapters/jupiter";
import type { AdapterHolding } from "./adapters/types";
import { getPriceMap, valuateHoldings, type ValuatedHoldings } from "./queries";
import type { Chain, Holding } from "./types";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Same two chains the auto-sync adapters support (evm.ts, jupiter.ts) — no
 * BTC, since there's no on-chain balance adapter for it in this app (BTC
 * wallets are manual-entry only). */
export function detectChain(address: string): Chain | null {
  if (EVM_ADDRESS_RE.test(address)) return "ETH";
  if (SOLANA_ADDRESS_RE.test(address)) return "SOL";
  return null;
}

// Gives every looked-up holding the shape valuateHoldings()/HoldingsTable
// expect, without a real wallet_id or DB row — this address was never
// saved anywhere, see lookupWallet's doc comment.
function toHolding(h: AdapterHolding, index: number): Holding {
  return {
    id: `lookup-${index}`,
    wallet_id: "lookup",
    ticker: h.ticker,
    qty: h.qty,
    usd_override: h.usd_override,
    source: "auto",
    contract: h.contract,
    category: h.category,
    chain: h.chain,
    icon_url: h.icon_url,
    updated_at: new Date().toISOString(),
  };
}

export interface LookupResult extends ValuatedHoldings {
  chain: Chain;
  address: string;
}

/**
 * The top-bar "search any address" feature — read-only, live-fetched
 * on-chain balances for an arbitrary ETH or SOL address, reusing the exact
 * same adapters as an auto wallet's "Sync holdings" (fetchEvmHoldings /
 * fetchJupiterHoldings). Nothing is written to the database: no wallet row,
 * no holdings row, so this can't collide with (or accidentally add to) the
 * user's actual saved portfolio. Pricing still uses the shared, already-
 * cached `prices` table (read-only) rather than fetching prices live, same
 * as any other holding rendered elsewhere in the app.
 */
export async function lookupWallet(rawAddress: string): Promise<LookupResult> {
  const address = rawAddress.trim();
  const chain = detectChain(address);
  if (!chain) {
    throw new Error("That doesn't look like a valid ETH or SOL address.");
  }

  const [adapterHoldings, prices] = await Promise.all([
    chain === "ETH"
      ? fetchEvmHoldings(address).then((r) => r.holdings)
      : fetchJupiterHoldings(address),
    getPriceMap(),
  ]);

  const holdings = adapterHoldings.map(toHolding);
  return { chain, address, ...valuateHoldings(holdings, chain, prices) };
}
