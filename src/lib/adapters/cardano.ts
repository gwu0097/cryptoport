import "server-only";
import { bech32 } from "@scure/base";
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

/**
 * A Cardano "base address" (the overwhelmingly common kind — what every
 * wallet checked so far, Ledger included, actually generates) encodes its
 * staking credential directly in its own bytes per CIP-19: header byte,
 * then a 28-byte payment credential, then a 28-byte staking credential.
 * Deriving the stake address is pure bech32 decode/re-encode, no API call
 * and no on-chain history needed — which matters, because Koios's own
 * address_info->stake_address lookup only has data for addresses that have
 * actually appeared in a transaction. A wallet's *current* receive address
 * is very often never-used (same rotation behavior as Bitcoin), so relying
 * on address_info alone silently missed real balances — confirmed against
 * a real Ledger address the API had zero history for, offline-derived its
 * stake address instead, and it resolved to the real 50,737 ADA balance.
 *
 * Returns null for address types with no inline staking credential
 * (pointer addresses, type 4-5 — reference a stake registration
 * indirectly; enterprise addresses, type 6-7 — no staking credential at
 * all), both rare in practice. Verified byte-for-byte against a real
 * address whose stake_address Koios's API had already confirmed.
 */
function deriveStakeAddress(paymentAddress: string): string | null {
  let bytes: Uint8Array;
  try {
    // Cardano addresses can exceed bech32's original ~90-char soft limit —
    // `false` disables that length check rather than rejecting valid,
    // longer-than-usual addresses.
    const { words } = bech32.decode(paymentAddress as `${string}1${string}`, false);
    bytes = bech32.fromWords(words);
  } catch {
    return null;
  }
  if (bytes.length < 57) return null; // not a full base address

  const header = bytes[0];
  const addressType = header >> 4;
  const network = header & 0x0f;
  if (addressType > 3) return null; // pointer (4-5) or enterprise (6-7) — no inline stake credential

  const stakeCredHash = bytes.slice(29, 57);
  // Base-address type encodes whether each credential is a key hash or a
  // script hash: types 0-1 -> stake credential is a key hash, types 2-3 ->
  // script hash. The reward-address header differs accordingly (0b1110 vs
  // 0b1111 per CIP-19).
  const stakeIsScript = addressType === 2 || addressType === 3;
  const rewardHeader = ((stakeIsScript ? 0b1111 : 0b1110) << 4) | network;
  const rewardBytes = new Uint8Array([rewardHeader, ...stakeCredHash]);
  return bech32.encode("stake", bech32.toWords(rewardBytes), false);
}

interface AddressInfoRow {
  balance: string;
}

interface AccountInfoRow {
  total_balance: string;
}

// Fallback only — used when deriveStakeAddress can't find an inline
// staking credential (pointer/enterprise addresses). Every base address
// (the common case) skips this call entirely now.
async function fetchAddressBalance(address: string): Promise<number> {
  const res = await fetchWithRetry(`${API_BASE}/address_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _addresses: [address] }),
  });
  if (!res.ok) throw new Error(`Koios address_info failed: HTTP ${res.status}`);
  const rows: AddressInfoRow[] = await res.json();
  return Number(rows[0]?.balance ?? 0); // [] for an address with no on-chain history — not an error
}

// total_balance = spendable UTXO + unclaimed staking rewards — included
// rather than just the spendable portion, same reasoning as Hyperliquid's
// unrealized PnL elsewhere in this app: unclaimed rewards are real
// economic value the wallet owns, not something to silently leave out.
async function accountBalance(stakeAddress: string): Promise<number> {
  const res = await fetchWithRetry(`${API_BASE}/account_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
  });
  if (!res.ok) throw new Error(`Koios account_info failed: HTTP ${res.status}`);
  const rows: AccountInfoRow[] = await res.json();
  return Number(rows[0]?.total_balance ?? 0);
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

async function resolveAndFetch(addressOrStake: string): Promise<{ lovelace: number; stakeAddress: string | null }> {
  if (addressOrStake.startsWith("stake1")) {
    return { lovelace: await accountBalance(addressOrStake), stakeAddress: addressOrStake };
  }
  const stakeAddress = deriveStakeAddress(addressOrStake);
  if (!stakeAddress) {
    return { lovelace: await fetchAddressBalance(addressOrStake), stakeAddress: null };
  }
  return { lovelace: await accountBalance(stakeAddress), stakeAddress };
}

/**
 * A Cardano wallet only ever has one holding tracked here (native ADA —
 * same scope as the BTC adapter, which likewise doesn't scan for Ordinals/
 * BRC-20; Cardano native tokens are a similar backlog item). Accepts
 * either a stake address (stake1...) directly, or a payment address
 * (addr1...) whose stake address is derived offline (see
 * deriveStakeAddress) — an address type with no inline staking credential
 * falls back to that one address's own balance. Priced via the shared
 * ticker-keyed `prices` table (usd_override: null) — Coinbase already
 * lists ADA-USD.
 *
 * No caching here (this is the plain, ephemeral-lookup interface, same as
 * bitcoin.ts's fetchBitcoinHoldings) — see fetchCardanoHoldingsForSync for
 * the cached version syncWalletHoldings uses for a real saved wallet.
 */
export async function fetchCardanoHoldings(addressOrStake: string): Promise<AdapterHolding[]> {
  const { lovelace } = await resolveAndFetch(addressOrStake);
  return buildAdaHolding(lovelace);
}

/**
 * Same as fetchCardanoHoldings, but for a real saved wallet: skips
 * derivation entirely once a stake address is already cached (from a
 * prior sync — see wallets.cardano_stake_address) and hands back whichever
 * stake address this sync used, so the caller can persist it. Unlike
 * BTC's script-type cache, there's no "Full sync" escape hatch needed here
 * — a payment address's staking credential is fixed at creation time and
 * cryptographically cannot change, so this cache never goes stale.
 */
export async function fetchCardanoHoldingsForSync(
  addressOrStake: string,
  cachedStakeAddress: string | null,
): Promise<{ holdings: AdapterHolding[]; stakeAddress: string | null }> {
  if (cachedStakeAddress) {
    return { holdings: await buildAdaHolding(await accountBalance(cachedStakeAddress)), stakeAddress: cachedStakeAddress };
  }
  const { lovelace, stakeAddress } = await resolveAndFetch(addressOrStake);
  return { holdings: await buildAdaHolding(lovelace), stakeAddress };
}
