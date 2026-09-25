import "server-only";
import { fetchEvmHoldings } from "./adapters/evm";
import { fetchBitcoinHoldings } from "./adapters/bitcoin";
import { isExtendedPublicKey } from "./walletDisplay";
import { fetchCardanoHoldings, isCardanoAddress } from "./adapters/cardano";
import { fetchCosmosHoldings, isCosmosAddress } from "./adapters/cosmos";
import { NON_EVM_DISPATCH, detectNonEvmChain } from "./adapters/nonEvmDispatch";
import type { AdapterHolding } from "./adapters/types";
import { getPriceMap, valuateHoldings, type ValuatedHoldings } from "./queries";
import { withPriceKeys } from "./adapters/assetKeys";
import { ensureAssetPrices } from "./adapters/assetPrices";
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
function toHolding(h: AdapterHolding & { price_key: string | null }, index: number): Holding {
  return {
    id: `lookup-${index}`,
    wallet_id: "lookup",
    ticker: h.ticker,
    price_key: h.price_key,
    qty: h.qty,
    usd_override: h.usd_override,
    source: "auto",
    contract: h.contract,
    category: h.category,
    chain: h.chain,
    icon_url: h.icon_url,
    protocol: h.protocol ?? null,
    protocol_url: h.protocol_url ?? null,
    display_label: h.display_label ?? null,
    protocol_section: h.protocol_section ?? null,
    position_side: h.position_side ?? null,
    position_leverage: h.position_leverage ?? null,
    position_entry_price: h.position_entry_price ?? null,
    position_liquidation_price: h.position_liquidation_price ?? null,
    position_pnl_usd: h.position_pnl_usd ?? null,
    position_pnl_percent: h.position_pnl_percent ?? null,
    updated_at: new Date().toISOString(),
  };
}

export interface LookupResult extends ValuatedHoldings {
  chain: Chain;
  address: string;
  /** Non-fatal partial failures from the adapter fan-out (e.g. one DeFi
   * source's RPC had a bad moment) — previously silently dropped here
   * (unlike wallets/actions.ts's real sync path, which already surfaces
   * these via wallets.last_refresh_status), which made a genuinely-missing
   * position indistinguishable from "the wallet just doesn't have one."
   * Empty when everything succeeded. */
  warnings: string[];
}

/**
 * The top-bar "search any address" feature — read-only, live-fetched
 * on-chain balances for an arbitrary ETH, SOL, BTC, or ADA address, reusing
 * the exact same adapters as an auto wallet's "Sync holdings"
 * (fetchEvmHoldings / fetchJupiterHoldings / fetchBitcoinHoldings /
 * fetchCardanoHoldings). Nothing is written to the database: no wallet
 * row, no holdings row, so this can't collide with (or accidentally add
 * to) the user's actual saved portfolio. Priced like any wallet: each
 * holding's price_key, any key without a fresh asset_prices row priced
 * now (ensureAssetPrices), then qty × that one price.
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
  // table syncWalletHoldings uses. BTC/ADA/SEI have no warnings concept of
  // their own (single-source adapters), so those legs just supply [].
  const fetchResult: Promise<{ holdings: AdapterHolding[]; warnings: string[] }> =
    chain === "ETH"
      ? fetchEvmHoldings(address)
      : chain === "BTC"
        ? fetchBitcoinHoldings(address).then((holdings) => ({ holdings, warnings: [] }))
        : chain === "ADA"
          ? fetchCardanoHoldings(address).then((holdings) => ({ holdings, warnings: [] }))
          : chain === "SEI"
            ? fetchCosmosHoldings("SEI", address).then((holdings) => ({ holdings, warnings: [] }))
            : NON_EVM_DISPATCH[chain].fetch(address);

  const { holdings: adapterHoldings, warnings } = await fetchResult;
  if (warnings.length > 0) {
    console.error(`lookupWallet(${chain} ${address}): ${warnings.join("; ")}`);
  }
  // Priced like any wallet (docs/pricing/PLAN.md): each holding's asset key,
  // any of those assets without a fresh price priced now (one batched pass),
  // then qty × the one price.
  const keyed = await withPriceKeys(adapterHoldings, "auto");
  await ensureAssetPrices(keyed.map((h) => h.price_key), "lookup").catch(() => {});
  const prices = await getPriceMap();

  const holdings = keyed.map(toHolding);
  return { chain, address, warnings, ...valuateHoldings(holdings, defaultChainId(chain), prices) };
}
