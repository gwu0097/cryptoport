import "server-only";
import { fetchEvmHoldings } from "./adapters/evm";
import { fetchJupiterHoldings } from "./adapters/jupiter";
import { fetchBitcoinHoldings } from "./adapters/bitcoin";
import { isExtendedPublicKey } from "./adapters/bitcoinXpub";
import type { AdapterHolding } from "./adapters/types";
import { getPriceMap, valuateHoldings, type ValuatedHoldings } from "./queries";
import { defaultChainId } from "./chainNames";
import type { Chain, Holding } from "./types";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// A Solana pubkey is always 32 raw bytes, which base58-encodes to 43-44
// characters in practice (32 only for the rare address with several
// leading zero bytes) — checked narrower than a generic "base58, some
// length" range specifically so it doesn't swallow a legacy/P2SH BTC
// address (also base58, but 25-34 raw bytes -> ~26-35 chars) below.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const BTC_BECH32_RE = /^(bc1)[a-z0-9]{25,90}$/;
const BTC_LEGACY_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** Every chain an auto-sync adapter exists for (evm.ts, jupiter.ts,
 * bitcoin.ts) — including an xpub/ypub/zpub, which behaves like a BTC
 * address here (bitcoin.ts dispatches to full account scanning for one). */
export function detectChain(address: string): Chain | null {
  if (EVM_ADDRESS_RE.test(address)) return "ETH";
  if (SOLANA_ADDRESS_RE.test(address)) return "SOL";
  if (BTC_BECH32_RE.test(address) || BTC_LEGACY_RE.test(address) || isExtendedPublicKey(address)) {
    return "BTC";
  }
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
 * on-chain balances for an arbitrary ETH, SOL, or BTC address, reusing the
 * exact same adapters as an auto wallet's "Sync holdings" (fetchEvmHoldings
 * / fetchJupiterHoldings / fetchBitcoinHoldings). Nothing is written to the
 * database: no wallet row, no holdings row, so this can't collide with (or
 * accidentally add to) the user's actual saved portfolio. Pricing still
 * uses the shared, already-cached `prices` table (read-only) rather than
 * fetching prices live, same as any other holding rendered elsewhere in
 * the app.
 */
export async function lookupWallet(rawAddress: string): Promise<LookupResult> {
  const address = rawAddress.trim();
  const chain = detectChain(address);
  if (!chain) {
    throw new Error("That doesn't look like a valid ETH, SOL, or BTC address.");
  }

  const fetchHoldings =
    chain === "ETH"
      ? fetchEvmHoldings(address).then((r) => r.holdings)
      : chain === "SOL"
        ? fetchJupiterHoldings(address)
        : fetchBitcoinHoldings(address);

  const [adapterHoldings, prices] = await Promise.all([fetchHoldings, getPriceMap()]);

  const holdings = adapterHoldings.map(toHolding);
  return { chain, address, ...valuateHoldings(holdings, defaultChainId(chain), prices) };
}
