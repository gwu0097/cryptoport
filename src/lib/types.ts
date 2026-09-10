// Row shapes as returned by PostgREST. `numeric` columns can come back as
// either a JS number or a string depending on PostgREST/client version —
// verified empirically that this project's setup returns numbers, but
// treat it as either. Parsing/validating them lives in valuation.ts, not
// here.

export type Chain = "BTC" | "ETH" | "SOL";
export type WalletMode = "manual" | "auto";
export type Account = "personal" | "biz";
export type HoldingSource = "manual_qty" | "manual_usd" | "auto";
export type HoldingCategory = "token" | "defi";
export type PriceSource = "coinbase" | "jupiter";

export interface Wallet {
  id: string;
  name: string;
  address: string | null;
  chain: Chain;
  mode: WalletMode;
  account: Account;
  notes: string | null;
  active: boolean;
  last_refresh_at: string | null;
  last_refresh_status: string | null;
  created_at: string;
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
  updated_at: string;
}

export interface Price {
  ticker: string;
  usd: number | string | null;
  source: PriceSource | null;
  updated_at: string | null;
}
