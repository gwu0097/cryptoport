// Notes a sync writes into wallets.notes (not the user's own words), kept
// here so a page can recognize one and show it as an explanation rather
// than as the wallet's note. Pure.

// Solana sync captures plain token balances plus Jupiter's own DeFi
// products (Earn, Limit Order, Perps, ...) via api.jup.ag/portfolio — but
// that API only covers Jupiter's own product suite, not third-party
// protocols (Meteora DLMM, Marinade, Kamino, Raydium, ...), which still
// aren't captured. Recorded in the wallet's notes rather than silently
// under-reporting with no explanation.
export const SOL_SYNC_NOTE =
  "Auto-synced token balances + DeFi positions from Jupiter (Earn, Limit Order, Perps, DAO staking), Kamino (lending, multiply, leverage, earn, liquidity, staking), Wormhole (staked W), Meteora (open DLMM positions), and Parcl (margin) — other protocols are not yet captured by this sync.";

/** Whether a wallet's notes are a sync's own explanation. */
export const isSyncNote = (notes: string | null) => notes === SOL_SYNC_NOTE;
