// The pre-registered backtest universe (docs/signals/PREREG_PULLBACK_INDICATORS.md
// §4): the Hyperliquid perps on the user's watchlists at registration
// (2026-09-23), plus BTC as the reference asset. Fixed — don't edit after
// results exist; a new universe is a new registration.
export const SIGNALS_UNIVERSE = [
  "kPEPE", "PONS", "ZEC", "VVV", "PUMP", "TAO", "UNI", "JTO", "VIRTUAL", "SUI", "NEAR", "HYPE", "SOL", "CASHCAT", "CRV",
  "LIT", "ARB", "ONDO", "MORPHO", "JUP", "ENA", "PENGU", "INJ", "FET", "USELESS", "CC", "XMR", "DASH", "WIF", "TRUMP",
  "kBONK", "AAVE", "W", "DOGE", "AVAX", "ETH", "MET", "BTC",
] as const;
