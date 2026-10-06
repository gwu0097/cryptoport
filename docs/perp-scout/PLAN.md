# Perp Scout

Owner request, 2026-10-06: follow consistently profitable Hyperliquid perp
traders, see what they've opened, and where price is now against their
entry, so the owner can decide whether to enter at a better price than they
did. It isn't copy trading: nothing is traded or copied, and nothing on the
page is a signal. Background is the sol-bot handoff (2026-10-05):
memecoin copying is a speed race, while perp swing traders hold for hours
to days.

## How it works

- **The list is curated in chat.** It is not discovered by the app; the
  owner, 2026-10-06: "I'm asking you to find them for me, then just add it
  to the list."
  - `src/lib/perpScout/followed.ts` (`FOLLOWED`) holds each trader's
    address, a name, why it's there, and the figures it was picked on.
  - Every change to the list is a commit.
  - The first version ran the trader screen from the page on every scan.
    It was dropped because the owner doesn't need a new trader search every
    time.
- **Scan** (Tools → Perp Scout) reads only the listed traders.
- **Entries** (the main table) shows every open position of the listed
  traders:
  - trader, coin and side;
  - when it was opened (with "+adds" if they added later);
  - size, share of the trader's equity and leverage;
  - their average entry and the price of the order that opened it ("first
    fill");
  - the price now, the move since their entry and since the first fill in
    their direction, and their PnL;
  - the nearest TP, SL ("none" when they have no stop) and liquidation
    price.

  Every column sorts. Filters: opened 24h / 7d / 30d / any, longs or
  shorts, one trader, and "only below their entry (above, for shorts)".
- **Refresh prices**: one `allMids` call swaps in current prices without a
  scan. The prices aren't stored.
- **Traders** (collapsible) shows the list: the figures each trader was
  picked on, plus their equity, leverage, book bias (long, short or hedged)
  and open positions from the last scan.

## Finding traders

Run in chat:

```
node scripts/diag/perp-scout-screen.mts [--review 70] [--top 25] [--json out.json]
node scripts/diag/perp-scout-screen.mts --address 0x… --address 0x…   # check specific wallets
```

The script is read-only, free and keyless, and touches no database. It uses
the same pure screen code as the tests (`perpScout/screen.ts`,
`perpScout/portfolio.ts`):

1. **Leaderboard** (`stats-data.hyperliquid.xyz/Mainnet/leaderboard`, the
   file the official leaderboard page loads, about 47K accounts). An account
   passes when it has:
   - an account of $50K–$20M;
   - all-time PnL ≥ $100K and all-time ROI ≥ 50%;
   - a profitable last 30 days;
   - monthly volume ≤ 60× its account value, which excludes market makers
     and HFT.
2. **Review set** of 70. Half are the largest all-time earners and half the
   largest earners over 30 days. ROI was tried first and picked accounts
   with a tiny first deposit (ROI +995,700%).
3. **Perps record only** (info `portfolio`, `perpAllTime` and `perpMonth`).
   The all-time window also counts spot and vault money, which made
   non-traders look like smooth winners. A trader passes with:
   - typical (median) perps equity ≥ $50K;
   - all-time perp volume ≥ 5× typical equity, and perp volume this month;
   - ≥ 26 weeks of history;
   - max drawdown of the **PnL curve** ≤ typical equity. Account value is
     wrong for this: deposits and withdrawals look like drawdowns;
   - ≤ 80% of profit made in the best 4 weeks;
   - ≤ 90% winning weeks. Swing traders win 50–65% of weeks. The first live
     screen's picks won 100% of weeks for 29 months with 0% drawdown and had
     no perp positions: funding farms, vaults or rewards.
4. **Rank** by yearly return on typical equity ÷ max drawdown share, with
   the drawdown floored at 10%.

**Seed list:** the handoff's 8 (its stage 3, run 2026-10-05 on the 60
largest earners). Most of them are whales running hedged books, so the next
step is to run the fixed screen for directional traders.

## Entries

For each listed trader, a scan reads:

- `clearinghouseState` for the main market only. HIP-3 markets aren't
  read.
- If they have a position: `userFills` (their latest 2,000) and
  `frontendOpenOrders`.

From those:

- **Opening fill**: walk the coin's fills to the last one that took the
  position from flat, or from the other side, to this side. Its order's
  average price is the "first fill" price.
- **Opened before the fills read**: shown as "over Nd", with no opening
  price. The API can't say more.
- **TP/SL**: `tpsl.ts` `hyperliquidTpsl` / `nearestTpsl`, the same code as
  the wallet sync.
- **Mark**: position value ÷ size, so it costs no extra call.

**Failure handling:**

- A trader whose positions can't be read, or isn't reached within 250 s,
  keeps the last scan's entries and is marked "not read". A failed read is
  never shown as an empty book.
- One scan runs at a time (`perp_scout_run`), and a scan under a minute old
  is reused.

## Cost

Hyperliquid's info API allows 1,200 weight a minute per IP. Weights from
Hyperliquid's docs:

| Request | Weight |
|---|---|
| `clearinghouseState`, `allMids` | 2 |
| `portfolio`, `frontendOpenOrders` | 20 |
| `userFills` | 20, plus 1 per 20 fills returned |

The app's calls go through one pacer per instance held at 1,000 a minute
(`perpScout/pacer.ts`).

- **A scan of 8 traders**: 8 × (2 + 20 + 20 + up to 100) ≈ 350–1,150
  weight, about 10–70 s.
- **A list of 40**: up to about 4 minutes, close to the route's limit.
  Traders not reached keep their last entries.
- **Supabase**:
  - a page view is 1 request (the `perp_scout` row);
  - a scan is about 5 (read, claim and release, save);
  - Refresh prices is 0, plus the abuse guard's lock check (at most 1 a
    minute).
- **Vercel**: 1 invocation per scan and 1 per Refresh prices.
- **Worst case for one user or bot**:
  - Scans: one runs at a time and a scan under a minute old is reused.
    Twenty scans an hour lock the user out for 24 h (`abuseGuard.ts`). All
    calls are free.
  - Refresh prices: 300 an hour (weight 2 each).
- **The screen script**: about 70 × 20 = 1,400 weight, spaced 1.2 s apart
  (about 1.5 minutes). It only runs when asked in chat.

## Verification

- 2026-10-06, first live scan: it ran, and the old in-app screen's picks
  were wrong (see step 3 above). That screen was replaced by the curated
  list.
- Still to check: the seeded 8 traders' entries against their accounts on
  app.hyperliquid.xyz.
- The screen script needs network access to Hyperliquid from wherever it
  runs. The cloud environment's network policy blocked it on 2026-10-06.

## Later (not built)

- Discord alerts when a listed trader opens a position. BACKLOG lists perp
  opens for Wallet Watch.
- HIP-3 markets.
- Hyperliquid's terms for the owner's region (still unchecked) matter
  before any trading.
