import "server-only";
import type { HoldingCategory } from "../types";

/** What an adapter hands back for one holding row, before insertion. */
export interface AdapterHolding {
  ticker: string;
  qty: number | null;
  /** Set when the adapter already knows the USD value directly (e.g. a
   * stablecoin pinned at $1, or a DeFi position's net value) — bypasses the
   * ticker-price pipeline entirely (see valuation.ts). */
  usd_override: number | null;
  contract: string | null;
  category: HoldingCategory;
  /** Sub-chain this holding came from, e.g. 'eth' | 'base' | 'hyperliquid' |
   * 'solana' — required (not optional) so it's a build error to add a new
   * adapter holding site without tagging it, rather than a silent gap that
   * only shows up as "ungrouped" on the Assets page. */
  chain: string;
  /** Logo URL, when the adapter's own data source has one — CoinGecko
   * (cached in token_registry.image_url) for EVM, Jupiter's own `icon`
   * field (free, already fetched) for Solana. Required, not optional, for
   * the same "no silent gap" reason as `chain`: Hyperliquid has no icon
   * source and explicitly passes null rather than omitting the field. */
  icon_url: string | null;
}
