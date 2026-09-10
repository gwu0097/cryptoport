// Row shapes as returned by PostgREST. `numeric` columns come back as
// strings, not numbers — parsing them lives in valuation.ts, not here.

export type Chain = "BTC" | "ETH" | "SOL";
export type WalletMode = "manual" | "auto";
export type Account = "personal" | "biz";
export type HoldingSource = "manual_qty" | "manual_usd" | "auto";
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
  qty: string | null;
  usd_override: string | null;
  source: HoldingSource;
  contract: string | null;
  updated_at: string;
}

export interface Price {
  ticker: string;
  usd: string | null;
  source: PriceSource | null;
  updated_at: string | null;
}
