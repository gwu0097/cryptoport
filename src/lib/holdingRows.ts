// What a holdings table in the browser gets: only the fields it shows, not
// the whole row (2026-09-29: Assets sent all 33 fields of 761 holdings,
// 960 KB a view). The client tables take these types, so a field a table
// starts to use without adding it here is a type error, not a blank cell.
// Pure.

import type { AssetGroup, AssetHoldingEntry, HoldingWithValuation } from "./queries.ts";

const HOLDING_ROW_FIELDS = [
  "id",
  "ticker",
  // The coin, for the token drawer (TokenLink).
  "price_key",
  "display_label",
  "icon_url",
  "source",
  "category",
  "contract",
  "qty",
  "price",
  "change24h",
  "valuation",
  "wallets",
  "usd_override",
  "protocol",
  "protocol_url",
  "position_side",
  "position_leverage",
  "position_entry_price",
  "position_liquidation_price",
  "position_pnl_usd",
  "position_pnl_percent",
] as const satisfies readonly (keyof HoldingWithValuation)[];

/** A row of HoldingsTable (Portfolio, a wallet, an influencer, the lookup). */
export type HoldingRow = Pick<HoldingWithValuation, (typeof HOLDING_ROW_FIELDS)[number]>;

export function toHoldingRows(holdings: readonly HoldingWithValuation[]): HoldingRow[] {
  return holdings.map((h) => pick(h, HOLDING_ROW_FIELDS));
}

const ASSET_HOLDING_FIELDS = ["id", "walletId", "walletName", "chainName", "ticker", "contract", "protocol", "protocol_url", "qty", "valuation"] as const satisfies readonly (keyof AssetHoldingEntry)[];

/** One asset's holdings as the Assets table's expanded row shows them. */
export type AssetHoldingRow = Pick<AssetHoldingEntry, (typeof ASSET_HOLDING_FIELDS)[number]>;
export type AssetRowGroup = Omit<AssetGroup, "holdings"> & { holdings: AssetHoldingRow[] };

export function toAssetRowGroups(groups: readonly AssetGroup[]): AssetRowGroup[] {
  return groups.map((g) => ({ ...g, holdings: g.holdings.map((h) => pick(h, ASSET_HOLDING_FIELDS)) }));
}

function pick<T, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}
