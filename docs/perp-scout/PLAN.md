# Perp Scout

Owner request, 2026-10-06: find consistently profitable Hyperliquid perp
traders, see what they have open, and where price is now against their entry,
so the owner can decide whether to enter at a better price than they did.
Not copy trading. Nothing is traded or copied, and no signal is claimed.
The background is the sol-bot handoff from 2026-10-05: memecoin copying is a
speed race, while perp swing traders hold for hours to days.

## What it shows (Tools → `/perp-scout`)

- **Scan** finds the top 20 traders and reads their open positions. It
  streams progress ("Checking traders' history 23/50…").
- **Entries** (the main table) lists every open position of those traders:
  - who holds it, the coin and side, and when it was opened (with "+adds"
    when they added later);
  - size, share of the trader's equity and leverage;
  - their average entry and the price of the order that opened it ("first
    fill");
  - the price now, the move since their entry and since the first fill, in
    their direction, and their PnL;
  - the nearest TP, SL ("none" when they have no stop) and liquidation price.

  Every column sorts. Filters: opened 24h / 7d / 30d / any, longs or
  shorts, one trader, and "only below their entry (above, for shorts)".
- **Refresh prices**: one `allMids` call swaps in current prices without a
  scan. The prices aren't stored.
- **Traders** (collapsible) shows the shortlist with the screen's figures,
  each trader's current leverage and book bias (long, short or hedged).
  Every column sorts.

## Screen

Ported from the handoff's stages, with its pitfalls fixed:

1. **Leaderboard** (`stats-data.hyperliquid.xyz/Mainnet/leaderboard`, the
   file the official leaderboard page loads, about 47K accounts). An account
   passes when it has:
   - an account of $50K–$20M;
   - all-time PnL ≥ $100K and all-time ROI ≥ 50%;
   - a profitable last 30 days;
   - monthly volume ≤ 60× its account value, which excludes market makers
     and HFT.
2. **Review set** of 50. Half are the largest all-time earners and half
   the best all-time ROI, alternating. The handoff reviewed only the 60
   largest earners, which made the shortlist all whales.
3. **PnL history** (info `portfolio`, the `perpAllTime` window). A trader
   passes with:
   - ≥ 26 weeks of history;
   - max drawdown of the **PnL curve** ≤ typical (median) equity. Account
     value was wrong for this: deposits and withdrawals read as
     drawdowns;
   - ≤ 80% of profit made in the best 4 weeks.
4. **Rank** by yearly return on typical equity ÷ max drawdown share, with
   the drawdown floored at 10%. Keep the top 20. The shortlist is reused for
   24 h; "Re-screen traders" forces a new one.

## Entries

For each of the 20 traders, the scan reads:

- `clearinghouseState` for the main market only. HIP-3 markets aren't
  read.
- If they have a position: `userFills` (their latest 2,000) and
  `frontendOpenOrders`.

From those:

- **Opening fill**: walk the coin's fills to the last one that took the
  position from flat, or from the other side, to this side. Its order's
  average price is the "first fill" price.
- **Opened before the fills read**: when the position was opened before the
  oldest fill read, it shows as "over Nd" with no opening price. That can't
  be known from the API.
- **TP/SL**: `tpsl.ts` `hyperliquidTpsl` / `nearestTpsl`, the same code as
  the wallet sync.
- **Mark**: position value ÷ size, so it costs no extra call.

## Failure handling

- A trader whose positions can't be read keeps the last scan's entries and
  is marked "not read". A failed read never shows as an empty book.
- Traders not reached within 250 s are handled the same way, since the
  route has 300 s.
- A leaderboard or portfolio answer in an unexpected shape is an error,
  never an empty result.

## Cost

Hyperliquid's info API allows 1,200 weight a minute per IP. Weights from
Hyperliquid's docs, not verified live:

| Request | Weight |
|---|---|
| `clearinghouseState`, `allMids` | 2 |
| `portfolio`, `frontendOpenOrders` | 20 |
| `userFills` | 20, plus 1 per 20 fills returned |

All of Perp Scout's calls go through one pacer per instance held at 1,000 a
minute (`perpScout/pacer.ts`), leaving room for the app's other Hyperliquid
reads.

- **Re-screen**: 1 leaderboard download (a few tens of MB, no weight) plus
  50 × 20 = 1,000 weight, about 1 minute.
- **Positions**: 20 × (2 + 20 + 20 + up to 100) ≈ 800–2,800 weight, about
  1–3 minutes. Active traders return the full 2,000 fills.
- **A scan reusing the shortlist**: about 1–3 minutes. **A first scan**:
  about 2–4 minutes.
- **Supabase**:
  - a page view is 1 request (the `perp_scout` row);
  - a scan is about 6 (read, claim and release, 1–2 saves);
  - Refresh prices is 0, plus the abuse guard's lock check (at most 1 a
    minute).
- **Vercel**: 1 invocation per scan (up to 300 s duration) and 1 per
  Refresh prices.
- **Worst case for one user or bot**:
  - Scans: one runs at a time app-wide, a scan under 2 minutes old is
    reused, and 20 scans an hour lock the user out for 24 h
    (`abuseGuard.ts`). That's at most about 15 scans an hour of real
    work, all free calls to Hyperliquid.
  - Refresh prices: 300 an hour (weight 2 each).

## Not verified

This was built in a sandbox that can't reach `api.hyperliquid.xyz`,
`stats-data.hyperliquid.xyz` or Supabase.

- The response shapes come from the existing adapters (`clearinghouseState`,
  `frontendOpenOrders`), Hyperliquid's Python SDK (fill fields) and the known
  shapes of `portfolio` and the leaderboard file. The parsers throw on an
  unexpected shape, so the first live scan will say so if any are wrong.
- The page was checked only with sample data, at 1440 px and 390 px.

**Gate:** the first live scan returns 20 traders with entries, and one
trader's positions match their account on app.hyperliquid.xyz.

## Later (not built)

- Discord alerts when a followed trader opens a position. BACKLOG lists
  perp opens for Wallet Watch.
- A directional-trader screen: clear long or short bias, uses stops, margin
  under ~50%.
- HIP-3 markets.
- Hyperliquid's terms for the owner's region (still unchecked) matter
  before any trading.
