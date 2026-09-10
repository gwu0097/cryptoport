import "server-only";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// Koios — free, keyless, community-run Cardano API. A wallet's real balance
// lives across every payment address delegated to one staking key, not
// just whichever address happened to get pasted in — Koios's account-level
// endpoints (below) aggregate that in a single call given the stake
// address, no BIP32-style gap-limit scanning needed the way Bitcoin's xpub
// required: Cardano's staking model already groups every address under one
// key by design.
const API_BASE = "https://api.koios.rest/api/v1";
const LOVELACE_PER_ADA = 1_000_000;

const ADDRESS_RE = /^addr1[a-z0-9]{50,110}$/;
const STAKE_ADDRESS_RE = /^stake1[a-z0-9]{50,70}$/;

export function isCardanoAddress(value: string): boolean {
  return ADDRESS_RE.test(value) || STAKE_ADDRESS_RE.test(value);
}

interface AddressInfoRow {
  balance: string;
  stake_address: string | null;
}

interface AccountInfoRow {
  total_balance: string;
}

async function fetchAddressInfo(address: string): Promise<AddressInfoRow | null> {
  const res = await fetchWithRetry(`${API_BASE}/address_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _addresses: [address] }),
  });
  if (!res.ok) throw new Error(`Koios address_info failed: HTTP ${res.status}`);
  const rows: AddressInfoRow[] = await res.json();
  return rows[0] ?? null; // [] for an address with no on-chain history — not an error
}

async function fetchAccountInfo(stakeAddress: string): Promise<AccountInfoRow | null> {
  const res = await fetchWithRetry(`${API_BASE}/account_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
  });
  if (!res.ok) throw new Error(`Koios account_info failed: HTTP ${res.status}`);
  const rows: AccountInfoRow[] = await res.json();
  return rows[0] ?? null;
}

async function resolveAddressInfo(address: string): Promise<{ stakeAddress: string | null; balance: number }> {
  const info = await fetchAddressInfo(address);
  return { stakeAddress: info?.stake_address ?? null, balance: Number(info?.balance ?? 0) };
}

// total_balance = spendable UTXO + unclaimed staking rewards — included
// rather than just the spendable portion, same reasoning as Hyperliquid's
// unrealized PnL elsewhere in this app: unclaimed rewards are real
// economic value the wallet owns, not something to silently leave out.
async function accountBalance(stakeAddress: string): Promise<number> {
  const account = await fetchAccountInfo(stakeAddress);
  return Number(account?.total_balance ?? 0);
}

async function buildAdaHolding(lovelace: number): Promise<AdapterHolding[]> {
  if (lovelace <= 0) return [];
  const images = await fetchTokenImages(["cardano"]).catch(() => new Map<string, string>());
  return [
    {
      ticker: "ADA",
      qty: lovelace / LOVELACE_PER_ADA,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "cardano",
      icon_url: images.get("cardano") ?? null,
    },
  ];
}

/**
 * A Cardano wallet only ever has one holding tracked here (native ADA —
 * same scope as the BTC adapter, which likewise doesn't scan for Ordinals/
 * BRC-20; Cardano native tokens are a similar backlog item). Accepts
 * either a stake address (stake1...) directly, or a payment address
 * (addr1...) resolved to its stake address via one address_info call — an
 * "enterprise" address with no staking credential falls back to that one
 * address's own balance. Priced via the shared ticker-keyed `prices` table
 * (usd_override: null) — Coinbase already lists ADA-USD.
 *
 * No caching here (this is the plain, ephemeral-lookup interface, same as
 * bitcoin.ts's fetchBitcoinHoldings) — see fetchCardanoHoldingsForSync for
 * the cached version syncWalletHoldings uses for a real saved wallet.
 */
export async function fetchCardanoHoldings(addressOrStake: string): Promise<AdapterHolding[]> {
  if (addressOrStake.startsWith("stake1")) {
    return buildAdaHolding(await accountBalance(addressOrStake));
  }
  const { stakeAddress, balance } = await resolveAddressInfo(addressOrStake);
  if (!stakeAddress) return buildAdaHolding(balance);
  return buildAdaHolding(await accountBalance(stakeAddress));
}

/**
 * Same as fetchCardanoHoldings, but for a real saved wallet: skips the
 * address_info resolution call entirely once a stake address is already
 * cached (from a prior sync — see wallets.cardano_stake_address) and hands
 * back whichever stake address this sync used, so the caller can persist
 * it. Unlike BTC's script-type cache, there's no "Full sync" escape hatch
 * needed here — a payment address's staking credential is fixed at
 * address-creation time and cryptographically cannot change, so this
 * cache never goes stale.
 */
export async function fetchCardanoHoldingsForSync(
  addressOrStake: string,
  cachedStakeAddress: string | null,
): Promise<{ holdings: AdapterHolding[]; stakeAddress: string | null }> {
  if (cachedStakeAddress) {
    return { holdings: await buildAdaHolding(await accountBalance(cachedStakeAddress)), stakeAddress: cachedStakeAddress };
  }
  if (addressOrStake.startsWith("stake1")) {
    return {
      holdings: await buildAdaHolding(await accountBalance(addressOrStake)),
      stakeAddress: addressOrStake,
    };
  }
  const { stakeAddress, balance } = await resolveAddressInfo(addressOrStake);
  if (!stakeAddress) return { holdings: await buildAdaHolding(balance), stakeAddress: null };
  return { holdings: await buildAdaHolding(await accountBalance(stakeAddress)), stakeAddress };
}
