// Whether a holding's price could actually be realized (docs/pricing/
// ILLIQUID.md, part B, owner decision 2026-09-26: shown, not counted). Pure.
//
// A holding is illiquid when it's worth more than its coin's whole 24h
// trading volume AND more than 5% of the coin's market cap — or, when the
// market cap is unknown, more than 10× that volume. Measured on real
// wallets: that flags airdropped junk (a 10B-token airdrop "worth" $339K
// trading $710 a day) and leaves real positions
// alone — a $4.8M SPX whale position (0.5× volume, 1% of market cap), an
// Aave receipt CoinGecko reports $0 volume for (0.0000x of market cap).
// Only CoinGecko-priced coins have volume; a coin without it (Jupiter,
// Hyperliquid, Coinbase prices — set by that venue's own trading) is never
// flagged.

export const ILLIQUID_VOLUME_MULTIPLE = 1;
export const ILLIQUID_MCAP_SHARE = 0.05;
/** With no market cap to compare against, only a position this many times
 * the coin's daily volume counts as illiquid. Airdropped junk runs in the
 * hundreds (WHITE 478×, KNCL 2,431×); a thinly traded but redeemable token
 * sits near 1× — Lido stMATIC at 1.15× was wrongly left out of the owner's
 * total on 2026-09-27 when its volume dipped under the position. */
export const ILLIQUID_UNKNOWN_MCAP_VOLUME_MULTIPLE = 10;
/** Below this a holding can't distort a total enough to matter; flagging it
 * would only add noise. */
export const ILLIQUID_MIN_USD = 1_000;

export interface CoinLiquidity {
  volume24h: number | null;
  marketCap: number | null;
}

export function isIlliquid(usd: number, coin: CoinLiquidity | undefined): boolean {
  if (!coin || coin.volume24h === null || usd < ILLIQUID_MIN_USD) return false;
  if (usd <= ILLIQUID_VOLUME_MULTIPLE * coin.volume24h) return false;
  if (coin.marketCap === null || coin.marketCap <= 0) return usd > ILLIQUID_UNKNOWN_MCAP_VOLUME_MULTIPLE * coin.volume24h;
  return usd > ILLIQUID_MCAP_SHARE * coin.marketCap;
}
