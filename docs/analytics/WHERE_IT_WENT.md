# Analytics: where it went — plan (owner 2026-10-14)

## Goal

In Analytics → "Everything else, by wallet", a coin line like `zksync 29,000 → 0`
says where it went (`→ 342 USDC on Arbitrum`, `→ Main Acct SubHyperliquid`), and
money moved between the user's own wallets is shown once, as a move, not as a
loss in one wallet and a gain in another.

Found by hand on the owner's 7D view (2026-10-14): Metamask Main's −$4,184 was
ZK → USDC (cross-chain swap zkSync → Arbitrum), SAND → ETH (same transaction),
1.1 weETH → USDC; $3,900 USDC deposited to Hyperliquid and sent to the
sub-account (+$3,466 shown elsewhere as "added since the snapshot").

## How others do it

Zerion, DeBank and CoinTracker classify each transaction from its transfer legs:
legs in and out in one transaction = trade; a transfer to or from another
address the user owns = internal move (excluded from flows); everything else =
deposit/withdrawal. Cross-chain swaps and bridges are matched by the
bridge/intent's two legs (same user, minutes apart, similar value). We do the
same over the app's own `transactions` table.

## Decisions

- **Source: the existing transaction sync** (`transactions` table,
  `fetchWalletTransactions` — Alchemy / Etherscan / Blockscout, Solana,
  Bitcoin, Cardano, Injective). No new table. Its history is stale for the
  owner (last synced 2026-09-17; 19 of 55 wallets never), so the panel gets a
  **"Find where it went"** button that syncs transactions only for the wallets
  with a coin change in the window, then shows the matches. Analytics itself
  keeps reading only stored data (CLAUDE.md §1).
- **Hyperliquid becomes a transaction source**: its ledger
  (`userNonFundingLedgerUpdates`, free, one call per account) written as
  `chain = 'hyperliquid'` rows — deposits, withdrawals and sends between
  accounts (sub-accounts are wallets too).
- **Matching** (pure `transferMatch.ts` + test), per coin that went down, in
  this order:
  1. same transaction has legs in → **trade** ("→ 0.0168 ETH");
  2. counterparty is another of the user's wallets → **moved** ("→ Ledger ETH");
  3. an in-leg to the same wallet on any chain within 10 minutes, value within
     10% → **cross-chain swap** ("→ 342 USDC on Arbitrum");
  4. a Hyperliquid deposit within 10 minutes of a USDC out on Arbitrum → "→
     Hyperliquid", then rule 2 for the send to the sub-account;
  5. otherwise "sent to 0x12…ab" (an outside address), or "not found" when the
     wallet's history isn't synced — never a guess.
- **Display:** the coin line shows its destination; a new top block
  "Moved between your wallets" lists internal moves once ($3,900 Metamask Main →
  Main Acct SubHyperliquid), and each wallet's "everything else" says how much
  of it was a move. The totals don't change (they're true per wallet).

## Phases

1. Matching over stored transactions + display (no new calls). Gate: the owner's
   7D view explains ZK, SAND, weETH from synced Metamask Main history.
2. "Find where it went" button: syncs the changed wallets' transactions
   (guard `findMoves` 10/h), then re-renders.
3. Hyperliquid ledger as a transaction source; the sub-account move shown once.

## Cost

- Page view: +1 Supabase request (the window's transactions for the user's
  wallets), in the page's first `Promise.all` — no extra round trip.
- A "Find where it went" click: one transaction sync per changed wallet — on
  EVM about 2 Alchemy calls per chain read (free tier, compute units), Solana
  as the existing sync (its RPC), Hyperliquid 1 free call. Owner's 7D: ~10
  wallets changed → ~100 Alchemy calls, ~1 minute. Writes: one upsert per
  wallet. Worst case one user: 10 clicks/h (guard) × ~100 calls.
- No CoinGecko calls; values from the snapshots' stored prices.

## Open

- Bridges other than Hyperliquid's (Across, Relay, Stargate) are matched by
  rule 3 only; a slow bridge (> 10 minutes) shows "sent to bridge 0x…".
