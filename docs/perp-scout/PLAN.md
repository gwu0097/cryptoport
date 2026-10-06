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
    price;
  - **Trader 30d**: the trader's perps PnL over the last 30 days, in
    dollars and as a share of their account (owner 2026-10-06: "how well
    the trader has been doing the last month");
  - **Role**: what the position is to its trader, inferred from the rest
    of their book (`entries.ts` `positionRole`; Hyperliquid doesn't say),
    with the reason on hover:
    - **Paired**: opened within 2 h of an opposite-side position;
    - **Hedge**: against a book that's net ≥ 50% the other way;
    - **Book leg**: in a book under 30% net either way;
    - **Directional**: with the book's lean, or their only position.

    On 2026-10-06 that read #1's 11 positions as book legs (net 4% short),
    #6's as directional (100% long), 0x8bae's BTC short + DOGE long as
    paired, and 0xa5fd's shorts as hedges against a 63%-long book.

  Every column sorts. Filters: opened 24h / 7d / 30d / any, longs or
  shorts, one trader, "only below their entry (above, for shorts)", and
  "directional only".
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
2. **Stage 1b**, still from leaderboard figures (`looksPromising`), keeps
   accounts that:
   - traded this month (volume ≥ account value);
   - made less than half their all-time profit in the last 30 days;
   - have all-time profit ≤ 30× their account value.

   Without it, 69 of 70 reviewed failed: 44 on one lucky month, 48 on not
   trading perps.
3. **Review set** of 150. Half are the largest all-time earners and half
   the largest earners over 30 days. ROI was tried first and picked
   accounts with a tiny first deposit (ROI +995,700%).
4. **Perps record** (info `portfolio`): perps PnL and volume
   (`perpAllTime`, `perpMonth`) against the **whole account's** value
   (`allTime`).
   - PnL counts perps only. The all-time PnL also counts spot and vault
     gains, which made non-traders look like smooth winners.
   - Equity counts the whole account, because a unified account keeps its
     cash in spot. #1's perps side alone read $1.1M of $6.1M, which turned a
     47% drawdown into 180%.

   A trader passes with:
   - typical (median) account value ≥ $50K;
   - all-time perp volume ≥ 5× typical equity, and perp volume this month;
   - ≥ 26 weeks of history;
   - max drawdown of the **PnL curve** ≤ typical equity. Account value is
     wrong for this: deposits and withdrawals look like drawdowns;
   - ≤ 80% of profit made in the best 4 weeks;
   - ≤ 90% winning weeks. Swing traders win 50–65% of weeks. The first live
     screen's picks won 100% of weeks for 29 months with 0% drawdown and had
     no perp positions: funding farms, vaults or rewards.
5. **Rank** by yearly return on typical equity ÷ max drawdown share, with
   the drawdown floored at 10%.

**The list, 2026-10-06:**
- **From the handoff (4):** #1, #2, #3 and #6. #4, #5, #7 and #8 were
  dropped: they had no perp positions and little or no perps profit. #8's
  $17.8M was spot gains, with no perp trade ever.
- **From the screen (7):** 13 of 150 passed. Skipped among those: traders
  turning their account over 48–84× a month (too fast to follow at a lag)
  and one at 96% drawdown.
- **Leaderboard counts that day:** 47,466 accounts, 5,855 passed stage 1,
  1,344 passed stage 1b.

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
- **Last added**: seen within the fills read, even for a position opened
  before them.
- **Equity, % of equity and leverage**: against the whole account's value
  (`portfolio`, which also gives the Traders table its live record).

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

- **A scan of 11 traders**: 11 × (2 + 20 + 20 + 20 + up to 100) ≈
  700–1,800 weight, about 10–80 s. The extra 20 per trader is `portfolio`.
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
- **The screen script**: about 150 × 20 = 3,000 weight, spaced 1.2 s apart
  (about 3 minutes). It only runs when asked in chat.

## Verification

- 2026-10-06, first live scan: it ran, and the old in-app screen's picks
  were wrong (see step 3 above). That screen was replaced by the curated
  list.
- 2026-10-06, entries built from live data for #1 matched HyperDash:
  - ZRO entry $1.79395;
  - ADA short −$315K at 22% of equity;
  - the only stop on XLM.

  Leverage reads 1.18× on Hyperliquid's $6.1M account value. HyperDash
  shows 1.7× on $4.2M, apparently leaving out its spot memecoins. For
  0xf97a the table showed open times, first-fill prices and adds.
- Limit: #1's 2,000 fills reach back only 7 days, so a position older than
  that shows "over 7d".
- In the cloud sandbox the script needs `NODE_USE_ENV_PROXY=1`, so Node's
  fetch uses the egress proxy. The environment allows `api.hyperliquid.xyz`
  and `stats-data.hyperliquid.xyz`.

## Later (not built)

- Discord alerts when a listed trader opens a position. BACKLOG lists perp
  opens for Wallet Watch.
- HIP-3 markets.
- Hyperliquid's terms for the owner's region (still unchecked) matter
  before any trading.
