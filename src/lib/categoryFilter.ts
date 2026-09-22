// Pure: which of a token's CoinGecko categories describe what it DOES
// (see categoryFilter.test.ts). Trend Finder anchors peers on these — a
// peer must share a functional category with the seed, not just a news
// event, a chain, or an investor.
//
// Reported directly (ZRO example): the AI named MORPHO/AERO/UNI as ZRO's
// peers because all were day-one Circle Arc launch partners — "like saying
// a project launched on Solana must be the same as another app launched on
// Solana." CoinGecko's own category list mixes function ("Cross-chain
// Communication", "Lending/Borrowing Protocols") with chain membership
// ("Base Ecosystem"), investors ("Multicoin Capital Portfolio"), listing
// venues ("Binance Alpha Spotlight"), index membership ("GMCI 30 Index")
// and geography ("Made in USA") — the non-functional ones are exactly the
// "launched on the same chain" relation, so they're dropped here. Patterns
// were set against real live category lists (2026-09-22: layerzero,
// wormhole, aerodrome-finance, uniswap, zcash, near, hyperliquid,
// render-token), not guessed.

const NON_FUNCTIONAL: RegExp[] = [
  / Ecosystem$/i, // chain membership: "Base Ecosystem", "Near Protocol Ecosystem"
  / Portfolio$/i, // investors: "Multicoin Capital Portfolio"
  / Native$/i, // "Base Native"
  /^Made in /i, // geography
  / Index$/i, // index membership: "Coinbase 50 Index", "Index Coop Defi Index"
  /^GMCI\b/i, // "GMCI Index", "GMCI DePIN Index"
  /Launchpad|Launchpool|Megadrop|HODLer Airdrop|Alpha Spotlight/i, // listing venue
  /^Alleged SEC Securities$/i,
  /^FTX Holdings$/i,
  /^Proof of (Work|Stake)/i, // consensus mechanism, not what the token does
  /^Governance$/i, // on nearly every token
];

// Functional but so broad they'd make nearly every DeFi or L1 token a
// "peer" — only used when a token has no more specific category at all.
const UMBRELLA = new Set(["Decentralized Finance (DeFi)", "Smart Contract Platform"]);

export interface FunctionalCategories {
  specific: string[];
  umbrella: string[];
  dropped: string[];
}

export function splitFunctionalCategories(names: readonly string[]): FunctionalCategories {
  const result: FunctionalCategories = { specific: [], umbrella: [], dropped: [] };
  for (const name of names) {
    if (NON_FUNCTIONAL.some((re) => re.test(name))) result.dropped.push(name);
    else if (UMBRELLA.has(name)) result.umbrella.push(name);
    else result.specific.push(name);
  }
  return result;
}

/** The categories a peer must share with the seed: the specific functional
 * ones, falling back to the umbrella ones only if there are none. Empty
 * means CoinGecko gives no functional category at all — the caller must
 * say so, not silently treat every AI suggestion as a verified peer. */
export function anchorCategories(names: readonly string[]): string[] {
  const { specific, umbrella } = splitFunctionalCategories(names);
  return specific.length > 0 ? specific : umbrella;
}
