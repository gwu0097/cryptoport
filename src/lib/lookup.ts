import "server-only";
import { fetchEvmHoldings } from "./adapters/evm";
import { fetchBitcoinHoldings } from "./adapters/bitcoin";
import { isExtendedPublicKey } from "./adapters/bitcoinXpub";
import { fetchCardanoHoldings, isCardanoAddress } from "./adapters/cardano";
import { fetchCosmosHoldings, isCosmosAddress } from "./adapters/cosmos";
import { NON_EVM_DISPATCH, detectNonEvmChain } from "./adapters/nonEvmDispatch";
import type { AdapterHolding } from "./adapters/types";
import { getPriceMap, valuateHoldings, type ValuatedHoldings } from "./queries";
import { defaultChainId } from "./chainNames";
import type { Chain, Holding } from "./types";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BTC_BECH32_RE = /^(bc1)[a-z0-9]{25,90}$/;
const BTC_LEGACY_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** Every chain an auto-sync adapter exists for (evm.ts, cardano.ts, plus
 * whatever's in nonEvmDispatch.ts's shared table — see that file's header)
 * — including an xpub/ypub/zpub, which behaves like a BTC address here
 * (bitcoin.ts dispatches to full account scanning for one), a Cardano
 * stake address alongside its usual addr1..., and Sei's Cosmos-native side
 * disambiguated by bech32 prefix from the generic EVM 0x... side. */
export function detectChain(address: string): Chain | null {
  if (EVM_ADDRESS_RE.test(address)) return "ETH";
  if (BTC_BECH32_RE.test(address) || BTC_LEGACY_RE.test(address) || isExtendedPublicKey(address)) {
    return "BTC";
  }
  if (isCardanoAddress(address)) return "ADA";
  // Sei's Cosmos-native side (sei1...) — a bech32 address here is never
  // ambiguous with the EVM 0x... side (already caught above), unlike
  // fetchAdapterHoldings in wallets/actions.ts, which has to disambiguate
  // by address format because both share the wallet.chain value "SEI".
  // Not in NON_EVM_DISPATCH for the same reason (see that file's header).
  if (isCosmosAddress("SEI", address)) return "SEI";
  return (detectNonEvmChain(address) as Chain | undefined) ?? null;
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
    protocol: h.protocol ?? null,
    protocol_url: h.protocol_url ?? null,
    updated_at: new Date().toISOString(),
  };
}

export interface LookupResult extends ValuatedHoldings {
  chain: Chain;
  address: string;
}

/**
 * The top-bar "search any address" feature — read-only, live-fetched
 * on-chain balances for an arbitrary ETH, SOL, BTC, or ADA address, reusing
 * the exact same adapters as an auto wallet's "Sync holdings"
 * (fetchEvmHoldings / fetchJupiterHoldings / fetchBitcoinHoldings /
 * fetchCardanoHoldings). Nothing is written to the database: no wallet
 * row, no holdings row, so this can't collide with (or accidentally add
 * to) the user's actual saved portfolio. Pricing still uses the shared,
 * already-cached `prices` table (read-only) rather than fetching prices
 * live, same as any other holding rendered elsewhere in the app.
 */
export async function lookupWallet(rawAddress: string): Promise<LookupResult> {
  const address = rawAddress.trim();
  const chain = detectChain(address);
  if (!chain) {
    throw new Error(
      "That doesn't look like a valid ETH, SOL, BTC, ADA, ATOM, INJ, SEI, NEAR, SUI, FIL, BCH, DOT, NEO, XRP, or TON address.",
    );
  }

  // ETH/BTC/ADA/SEI are handled directly (not through NON_EVM_DISPATCH —
  // see nonEvmDispatch.ts's and detectChain's doc comments for why each is
  // special-cased); everything else comes from the same shared dispatch
  // table syncWalletHoldings uses.
  const fetchHoldings: Promise<AdapterHolding[]> =
    chain === "ETH"
      ? fetchEvmHoldings(address).then((r) => r.holdings)
      : chain === "BTC"
        ? fetchBitcoinHoldings(address)
        : chain === "ADA"
          ? fetchCardanoHoldings(address)
          : chain === "SEI"
            ? fetchCosmosHoldings("SEI", address)
            : NON_EVM_DISPATCH[chain].fetch(address).then((r) => r.holdings);

  const [adapterHoldings, prices] = await Promise.all([fetchHoldings, getPriceMap()]);

  const holdings = adapterHoldings.map(toHolding);
  return { chain, address, ...valuateHoldings(holdings, defaultChainId(chain), prices) };
}
