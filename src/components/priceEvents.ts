/** Sent on `window` when the app's Refresh prices finishes, so panels that
 * price from elsewhere (Perp Scout's tracked trades: Hyperliquid's mids) can
 * refresh with it (owner 2026-10-06: "refresh prices should update the price
 * on tracked trades just like my open positions"). */
export const PRICES_REFRESHED_EVENT = "cryptoport:prices-refreshed";
