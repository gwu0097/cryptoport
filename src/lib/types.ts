// Row shapes as returned by PostgREST. `numeric` columns can come back as
// either a JS number or a string depending on PostgREST/client version —
// verified empirically that this project's setup returns numbers, but
// treat it as either. Parsing/validating them lives in valuation.ts, not
// here.

/** Chains an auto-sync adapter actually exists for. A wallet's own `chain`
 * field is NOT restricted to this — see Wallet.chain below — this is
 * narrower on purpose, mainly for lookup.ts's address-detection return
 * type. Any EVM chain beyond "ETH" (RON, ARB, ...) isn't listed here
 * (fetchAdapterHoldings in wallets/actions.ts dispatches those by a plain
 * runtime check against evmChains.ts instead, not this union) — "ETH"
 * already covers detection for any 0x address, since which of the 32 EVM
 * chains it actually holds anything on can only be known by scanning, not
 * guessed from the address alone. */
export type Chain =
  | "BTC"
  | "ETH"
  | "SOL"
  | "ADA"
  | "ATOM"
  | "INJ"
  | "NEAR"
  | "SUI"
  | "FIL"
  | "BCH"
  | "DOT"
  | "TAO"
  | "SEI"
  | "NEO"
  | "XRP"
  | "TON";
export type WalletMode = "manual" | "auto";
/** "auto_defi" and "auto_exchange" are additional disjoint sync-owned
 * sources — "auto_defi" for Zerion-backed EVM DeFi positions (zerionDefi.ts),
 * "auto_exchange" for a connected exchange account's balances
 * (coinbaseAdvancedTrade.ts) — each deliberately distinct from "auto" (the
 * regular multicall/adapter sync) so every sync's own delete-then-insert RPC
 * (sync_auto_holdings / sync_defi_holdings / sync_exchange_holdings) can
 * never clobber another's rows. */
export type HoldingSource = "manual_qty" | "manual_usd" | "auto" | "auto_defi" | "auto_exchange";
export type HoldingCategory = "token" | "defi";
export type PriceSource = "coingecko" | "coinbase" | "jupiter";

/** Every source a real sync writes, never hand-editable by the user —
 * checked as an allowlist inversion ("anything not manual is sync-owned")
 * rather than listing sync sources by name, so a future third sync-owned
 * source doesn't need this same audit repeated at every call site. */
const MANUAL_SOURCES: ReadonlySet<HoldingSource> = new Set(["manual_qty", "manual_usd"]);
export function isSyncOwned(source: HoldingSource): boolean {
  return !MANUAL_SOURCES.has(source);
}

export interface Tag {
  id: string;
  name: string;
}

/** A signature-verified proof of wallet ownership (see walletAuth.ts) —
 * distinct from Wallet above, which is portfolio-tracking data with no
 * ownership proof at all. See db/schema.sql's linked_wallets comment. */
export interface LinkedWallet {
  id: string;
  chain: "ETH" | "SOL";
  address: string;
  verified_at: string;
}

export interface Wallet {
  id: string;
  name: string;
  address: string | null;
  /** Free text, not restricted to Chain above — a manual wallet can track
   * any chain ("RON", "NEAR", whatever), auto-sync just isn't available
   * for anything outside Chain (enforced in wallets/actions.ts, both in
   * the UI and again server-side). Always stored uppercase. */
  chain: string;
  mode: WalletMode;
  notes: string | null;
  active: boolean;
  last_refresh_at: string | null;
  last_refresh_status: string | null;
  /** Set the moment a sync begins (before the background work even starts)
   * — used to compute last_sync_duration_ms once it finishes. */
  sync_started_at: string | null;
  last_sync_duration_ms: number | null;
  /** Cached from a prior full BTC xpub scan (see bitcoinXpub.ts) — which of
   * the three address formats actually has this wallet's funds, so later
   * syncs can go straight to it instead of checking all three again. Only
   * ever meaningful for chain='BTC' wallets whose address is an xpub. */
  btc_script_type: "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | null;
  /** Cached from a prior sync (see adapters/cardano.ts) — the stake address
   * a chain='ADA' payment address resolves to, so later syncs skip the
   * resolution call and go straight to the account-level balance lookup.
   * Never goes stale (a payment address's staking credential can't change
   * once set), unlike BTC's script-type cache. */
  cardano_stake_address: string | null;
  /** Separate from last_refresh_at/last_refresh_status (holdings) — see
   * schema.sql's own comment: transaction sync has its own cadence and can
   * fail independently of a holdings sync. */
  tx_synced_at: string | null;
  tx_sync_status: string | null;
  /** Set the moment a transaction sync begins — same role as
   * sync_started_at above, for the tx job specifically. Existed in the DB
   * from the start but was missing here until this same DeFi-sync pass
   * noticed the gap. */
  tx_sync_started_at: string | null;
  /** A third, independent job on this same row (see holdings.source's
   * "auto_defi" doc comment) — its own status/timestamps for the identical
   * reason tx_sync_* has its own: a DeFi-position sync (Zerion) has its own
   * cadence and can fail independently of both the holdings sync and the
   * transaction sync. */
  defi_sync_status: string | null;
  defi_sync_started_at: string | null;
  defi_synced_at: string | null;
  defi_sync_duration_ms: number | null;
  /** Set only for a connected-exchange wallet (see exchange_connections in
   * schema.sql) — null for every on-chain wallet. 'coinbase' for now, built
   * to take a second value the day another exchange is added. Discriminates
   * "this wallet has no on-chain address, its holdings come from an
   * API-key-authenticated exchange sync" from the regular wallet shape. */
  provider: string | null;
  /** A fourth independent job on this same row (see holdings.source's
   * "auto_exchange" doc comment) — same "own status/timestamps, own cadence"
   * reasoning as the tx_sync_ and defi_sync_ fields above. */
  exchange_sync_status: string | null;
  exchange_sync_started_at: string | null;
  exchange_synced_at: string | null;
  exchange_sync_duration_ms: number | null;
  created_at: string;
}

/** A wallet row as actually queried — always comes back with its tags
 * embedded (see queries.ts), never a bare id list. User-defined, free-text
 * categorization, many-to-many via cryptoport.wallet_tags (replaced the old
 * fixed personal/biz "account" enum, then a single nullable tag_id, before
 * settling on many-to-many — see resolveTagIds in wallets/actions.ts:
 * typing a new name creates the tag, an existing name reuses it). */
export interface WalletWithTags extends Wallet {
  tags: Tag[];
}

export interface Transaction {
  id: string;
  wallet_id: string;
  chain: string;
  tx_hash: string;
  leg: number;
  occurred_at: string;
  direction: "in" | "out" | "self" | "unknown";
  ticker: string | null;
  amount: number | string | null;
  counterparty: string | null;
  explorer_url: string | null;
  fee: number | string | null;
  synced_at: string;
}

export interface Holding {
  id: string;
  wallet_id: string;
  ticker: string;
  qty: number | string | null;
  usd_override: number | string | null;
  source: HoldingSource;
  contract: string | null;
  category: HoldingCategory;
  /** Sub-chain within the wallet's chain (an 'ETH' auto wallet spans many
   * EVM chains) — 'eth' | 'base' | ... | 'hyperliquid' | 'solana'. Null for
   * manual holdings; callers grouping by chain should fall back to the
   * wallet's own `chain` field in that case. */
  chain: string | null;
  /** Logo URL — see AdapterHolding.icon_url. Null for manual holdings and
   * any auto holding whose source has no icon (Hyperliquid). */
  icon_url: string | null;
  /** Which DeFi protocol/product this position lives in (e.g. "Jupiter
   * Earn") and a link to it — see AdapterHolding.protocol. Null for every
   * holding except a DeFi position an adapter tagged with one. */
  protocol: string | null;
  protocol_url: string | null;
  updated_at: string;
}

export interface Price {
  ticker: string;
  usd: number | string | null;
  source: PriceSource | null;
  updated_at: string | null;
  change_24h_pct: number | string | null;
}
