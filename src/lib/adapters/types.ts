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
  /** Which DeFi protocol/product this position lives in (e.g. "Jupiter
   * Earn") and a link to it, when the adapter's source has that concept —
   * unlike `chain`/`icon_url`, genuinely optional (not "required but often
   * null"): a plain token balance has no protocol, and every existing
   * non-DeFi adapter site is correct to simply omit these two rather than
   * being forced to add `protocol: null` everywhere. Only set by adapters
   * producing 'defi' category holdings (currently jupiterPositions.ts). */
  protocol?: string | null;
  protocol_url?: string | null;
  /** Overrides the ticker text shown in the UI (e.g. "Perps Withdrawable",
   * "Hyperliquidity Provider (HLP)") without changing `ticker` itself —
   * `ticker` stays the real asset symbol (still "USDC") so ticker-keyed
   * grouping/pricing (the Assets page, prices.ts) is unaffected; several
   * distinct balances can legitimately share one ticker while needing
   * different on-screen labels (Hyperliquid's cross-margin "Available" vs
   * "Withdrawable" USDC, or a vault's own name, are both still just USDC).
   * Optional — every holding without a reason to override just omits it. */
  display_label?: string | null;
  /** Sub-groups a protocol's own holdings for display (e.g. Hyperliquid's
   * "Deposit"/"Perpetuals"/"Yield"/"Rewards", matching how DeBank breaks
   * the same account down) — purely a rendering hint, never used for
   * grouping/totals math. Optional: every protocol without sub-groups
   * (Jupiter Earn, Kamino, ...) omits it and renders as one flat list,
   * same as before this field existed. */
  protocol_section?: string | null;
  /** Leveraged-position detail — genuinely optional like `protocol` above:
   * only an open perp/futures position has any of these, a plain token or
   * spot DeFi holding correctly omits them all. Currently only
   * hyperliquid.ts sets these (see fetchHyperliquidHoldings); added as
   * named fields now rather than only when a second adapter needs them
   * because a leveraged-position gap was already flagged once before, for
   * Coinbase's CFM perp futures (see coinbaseAdvancedTrade.ts's own
   * warning) — this shape is meant to cover that too when it's built. */
  position_side?: "long" | "short" | null;
  position_leverage?: number | null;
  position_entry_price?: number | null;
  position_liquidation_price?: number | null;
  /** Informational only, NOT what prices the position (see valueHolding's
   * usd_override handling — usd_override is margin committed, matching how
   * DeBank/Hyperliquid's own UI value an open position: "how much capital
   * is deployed" rather than "how much have I made or lost"). Shown as a
   * separate colored stat alongside the position, never summed into any
   * total — margin already accounts for that capital once. */
  position_pnl_usd?: number | null;
}

/** What a transaction adapter hands back for one on-chain event, before
 * insertion into cryptoport.transactions. Deliberately loose on amount/
 * direction/counterparty (all nullable) rather than requiring an adapter
 * to force a guess when a transaction's effect on the wallet genuinely
 * can't be determined cleanly (e.g. a Solana transaction touching many
 * accounts at once) — same "unknown beats a plausible-looking wrong
 * number" reasoning as valuation.ts's Valuation type. */
export interface AdapterTransaction {
  /** Chain-native transaction id — the primary key half that makes a
   * transaction unique together with wallet_id (see transactions' unique
   * constraint doc comment in schema.sql for why chain is also part of
   * it: one EVM "wallet" spans many chains with independent hash spaces). */
  txHash: string;
  /** Sub-chain this happened on, same vocabulary as holdings.chain — 'eth'
   * | 'arb' | ... for EVM, 'bitcoin', 'solana'. */
  chain: string;
  occurredAt: string; // ISO timestamp
  direction: "in" | "out" | "self" | "unknown";
  /** Display ticker for the asset that moved — null when a transaction
   * touched multiple assets/instructions and no single one is "the"
   * transfer (shown as a bare hash + timestamp rather than guessed at). */
  ticker: string | null;
  amount: number | null;
  /** The other address involved, when there's a clear single one — null
   * for the same multi-instruction reason as ticker. */
  counterparty: string | null;
  explorerUrl: string | null;
  /** Fee paid, in the transaction's native unit (ETH, BTC, SOL) — null
   * when the wallet wasn't the one paying it (an incoming transfer) or the
   * adapter has no fee data. Purely informational, shown on the row. */
  fee: number | null;
}
