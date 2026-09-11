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
 * already covers detection for any 0x address, since which of the 31 EVM
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
export type HoldingSource = "manual_qty" | "manual_usd" | "auto";
export type HoldingCategory = "token" | "defi";
export type PriceSource = "coinbase" | "jupiter";

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
  /** User-defined, free-text categorization — replaced the old fixed
   * personal/biz "account" enum (see resolveTagId in wallets/actions.ts:
   * typing a new name creates the tag, an existing name reuses it). */
  tag_id: string | null;
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
  created_at: string;
}

/** A wallet row as actually queried — always comes back with its tag
 * embedded (see queries.ts), never just the bare tag_id. */
export interface WalletWithTag extends Wallet {
  tag: Tag | null;
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
