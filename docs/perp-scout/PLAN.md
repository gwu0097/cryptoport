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

  - **Their gain**: their return on margin, the move since their entry ×
    their leverage (Hyperliquid's ROE), with their dollar PnL in grey
    beside it. The owner doesn't trade their size, so the % is what counts.
    "vs entry" is the gain at 1×.

  Every column sorts. Filters: opened 24h / 7d / 30d / any, longs or
  shorts, one trader, "only below their entry (above, for shorts)", and
  "directional only".
- **Last move**: each position's latest move within the fills read, as a
  colored badge with its age: **New** (green), **Added** (blue),
  **Trimmed** (amber; cut without closing or flipping). Rows that moved in
  the last 24 h get a matching colored left edge (`entries.ts`
  `latestMove`). Coin logos come from the app's icon cache
  (`resolveTickerIcons`, stored on each entry by the scan; CoinGecko only
  for a ticker never seen).
- **Group by coin** (a checkbox): one header row per coin, showing how
  many traders hold it, long vs short, how many are directional, the
  combined size, and the average entry when all are on one side
  (`groups.ts`). Coins follow the table's sort, each placed by its top row (owner 2026-10-06: sorting by Opened left HYPE above BTC, because coins had been ordered by trader count). Each coin
  **starts collapsed** to its header, which also shows the coin's latest
  move and how many of its positions moved in 24 h; click it for every
  trader's row (owner: "as we get more addresses it's going to be hard to
  read"). There's an Expand / Collapse all toggle. On 2026-10-06's
  real scan (78 positions) ZEC was held by 4 of the 11.
- **Refresh prices**: one `allMids` call swaps in current prices without a
  scan. The prices aren't stored.
- **Traders** (collapsible) shows the list: the figures each trader was
  picked on, plus their equity, leverage, book bias (long, short or hedged)
  and open positions from the last scan.

## Adding traders on the page

The owner can add a trader by address (and an optional name) under the
Traders table (`AddTraderForm` → `api/perp-scout/traders` →
`perpScoutScan.ts` `addTrader`; owner 2026-10-06). It reads the address's
record once (`portfolio`, weight 20) for the figures it's added on, and
refuses an address with no perp history.

- Added traders live in `app_settings` `perp_scout_added`, beside the code
  list. Scan reads both (`mergeFollowed`), up to 40.
- Any trader can be removed there (✕, with a confirm; owner 2026-10-06:
  "can only add, can't delete"). One added on the page is deleted. One from
  the code list is hidden through the same row's `removed` addresses
  (`mergeFollowed`); adding its address again brings it back.
- Owner only: the list is shared by every viewer. Other users see it
  read-only.
- Their positions show after the next Scan.

**Closed positions** (owner 2026-10-06: "missing closed positions") are
rows in the **Activity** table, the table once called Entries (owner: "in
the same table as entries… rename it activity… under BTC maybe there's 1
long 1 short and 3 closes"). Each grey "Closed" row is a position closed in
the last 7 days (`closes.ts` `recentCloses`, `CLOSES_DAYS`). A close is a
position going back to flat, or flipping; trims along the way are part of
the same exit. It shows when, how long it was held, the average entry and
exit, the return in their direction (at 1×) and the realized PnL (before
fees).
- For a position opened before the fills read, the entry is worked back
  from the realized PnL (`closedPnl`), and Held shows "—".
- Every scan now reads each trader's fills, not only those with a position
  open: about 22 × up to 120 weight, roughly 1–2 minutes for 22 traders. A
  trader whose fills fail keeps the last scan's closes.
- On the real scan that day there were 89 closes across 22 traders.

A trader's closes of one coin on one side are **summed into one row**
(`closes.ts` `summarizeCloses`; owner: "this looks like 8 closes but really
it's just 1"). The row shows "Closed ×8 · last 3d ago", the total size, the
size-weighted entry and exit, the combined return (total PnL ÷ the entry
value closed) and the total PnL; each close is listed on hover. The time
filter picks the closes first, then sums them.

**Fill order** (fixed 2026-10-06): userFills lists newest first, including
the pieces of one order filled in the same millisecond. Re-sorting by time
kept those pieces backwards, so a position seemed to go flat and reopen
between them, producing closes with no open and misread trims (0xf97a's
fills broke the position chain 1,766 times). `parseFills` now reverses the
list, which gives 0 breaks on perps, and drops spot fills ("@107"); their
fees break the chain and they aren't perp positions. Re-measured, the swing
hold times on the list were unchanged.

A status filter shows Open & closed, Open or Closed. Group by coin counts
closes in the coin's header ("BTC · 8 traders · 2 long / 2 short · 9
closed"); they count toward its traders but not its size or average entry
(`groups.ts`).

**The time filter is "Moved 24h / 7d / 30d"**: opened, added to, trimmed or
closed in that window (`latestMove`). "Opened 7d" hid #1's UNI long, which it had
added to 2 days earlier.

**A trader's positions**: ▸ beside each name, or a click on its Open
count, shows that trader's open positions under its row. They start
collapsed. Each shows coin, side, last move, size, % of equity, leverage,
entry, price now, vs entry, their gain and SL.

**Traders table %**: each PnL figure leads with its % gain, with dollars in
grey (owner: "numbers don't mean anything to me, need % gain"). Both
columns sort by the %.
- **All-time %**: perps profit ÷ the account's typical (median) value, the
  money it usually trades with, so deposits and withdrawals don't move it.
- **30d %**: the last 30 days' perps profit ÷ the account now.

## Import, export and names

Owner 2026-10-06. **Export** (everyone): the list as CSV — address, name,
added on, why — built in the browser, no request. **Import** (owner): a
file or pasted text — that CSV, Perp Scout JSON, or one address per line
with an optional name after a comma (`perpScout/traderFile.ts`
`parseTraderImport`); `importTraders` reads each new address's record
(portfolio, weight 20, one at a time through the pacer, ~1 s each) and
saves once; already listed or past `MAX_FOLLOWED` are refused and named.
**Rename** (owner): the pencil beside a name (`renameTrader`); names live in
`perp_scout_added` `names`, by address, so code-list traders can be
renamed too (`mergeFollowed` applies them). Cost: an import of 40 is ~800
weight and 2 Supabase requests; a rename is 2.

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
- **Swing screen (11 more, the same day):** `--swing` over 500 accounts in
  two batches of 250 (`--skip 250`): 21 + 20 passed the record screen, and
  12 + 9 of those were swing traders. 11 new ones were added with 12-month
  returns of +61% to +372% and positive 30 days, holding 5 h–7 d at 6–88
  orders a week. Not swing: #2 and 0x8bae (no position opened and closed
  in 30 days) and 0x5cbd (325 orders a week); the owner decides on those.
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

## Incremental scans

Owner 2026-10-06: "shouldn't that delta be tiny and super fast?" After a
trader's first full read, a scan reads only what changed (`perpScoutScan.ts`
`readBook`):
- the positions (`clearinghouseState`, weight 2);
- the fills since the newest one already read (`userFillsByTime`, oldest
  first, at most 2,000 a call, so read page by page up to 5 pages:
  `fetchFillsSince`);
- the record only every 6 h (`STATS_MAX_AGE_MS`);
- the TP/SL orders only when the trader traded, or every 30 min.

Each book keeps its cursor (`fillsThrough`) and read times. What the new
fills don't touch is carried from the last scan (`entries.ts` `carryOver`,
`keepTpsl`; `closes.ts` `mergeCloses`): when a position was opened and at
what price, earlier adds and trims, and earlier closes. A first read, a gap
over 7 days, a failed fills read or more new fills than the pages hold
reads in full.

Checked 2026-10-06 on 5 real traders by replaying the last 72 h and 30 h of
fills (up to 1,223) as deltas: the opening times, first fills, adds, trims
and closes matched a full read exactly. A routine update costs about 22
weight per trader, against about 150 in full: a few seconds for 22 traders
instead of 2–3 minutes. Supabase stays at about 5 requests a scan.

## Tracked trades

Owner 2026-10-06: "if I want to track a specific trade, I mark it, and
another table lists the trades I care about — open, closed or stopped".

- **Marking**: ☆ on any Activity row (open or closed) stores the position
  — trader, coin, side, when it was opened — with its figures at that
  moment (entry, price, size, leverage, TP, SL) in the user's own
  `app_settings` row `perp_scout_tracked:<user id>` (`{ trades }`, at most
  `MAX_TRACKED` 50; `api/perp-scout/tracked` POST/DELETE). No DDL.
- **Status** (`perpScout/tracked.ts` `resolveTracked`, pure, from the
  latest scan): Open (with the trader's latest add or trim), Take-profit
  hit or Stopped out (the exit within 0.5% of the TP or SL it had when
  marked), Closed, or Not seen (closed longer ago than the closes kept).
  A later position in the same coin is another trade (`openedAt`).
- **Figures in %** (owner: dollars mean little at another size): "Their
  gain" is the return on margin (move × leverage) — once closed, the
  return × the leverage it had when marked, else at 1× (labelled); their
  dollar PnL is only in the tooltip. "Since tracked" is the move at 1×.
- **Where**: the first section of Perp Scout, and on the Dashboard beside
  Open positions (Open positions 6 | tracked 6 columns; either alone takes
  the row). Every Perp Scout section is collapsible.
- **Two buttons** (owner): *Refresh prices* updates prices only — one
  `allMids` call, shared with the Activity table's, and the app's own
  Refresh prices triggers it too (`PRICES_REFRESHED_EVENT`). *Refresh*
  re-reads only the traders behind the tracked trades (`runScan` with
  `only`, `api/perp-scout/tracked/refresh`) — the same delta read as a
  Scan, so a close, add or trim shows; the others keep their last scan.
- **Cost**: the Dashboard reads one more `app_settings` row set in its
  first reads (the scan row and the user's list, one request, ~80 KB from
  the database; only the tracked traders' rows reach the browser). A
  Refresh is ~4 Supabase requests and, per tracked trader, weight 2 + the
  new fills (≈ 25); 60 an hour lock the user out (`perpScoutTracked`).
  Worst case for one user: 60 × 22 traders × ~25 ≈ 33,000 weight an hour,
  paced to 1,000 a minute.

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

## Alerts (Discord)

Owner 2026-10-07: "send a discord message every time one of the wallets in
perp scout makes a trade, and alert specifically if there's a new position
opened" — run from the Mac mini (owner: no Vercel or Supabase per poll).

- **Where**: `scripts/perp-alerts.ts`, kept running by launchd
  (`scripts/launchd/com.cryptoport.perp-alerts.plist`). Hyperliquid has no
  webhooks, so it polls every 30 s. Its state (each trader's positions at
  the last read) is a local file, `~/.cryptoport/perp-alerts.json`.
  Supabase is read only for the trader list (`perp_scout_added`), once an
  hour, and never written. Vercel isn't involved.
- **What posts** (pure `perpScout/alerts.ts`), one message per position
  change, never per fill (one trader makes ~285 fills a day):
  - **Opened**: pings the role (`DISCORD_PERP_ROLE_ID`, else
    `DISCORD_WATCH_ROLE_ID`), with size, share of the whole account
    (`portfolio`), entry, liquidation, TP and SL.
  - **Closed**: ✅/❌ with entry → exit, the % at 1× and on margin, and this
    exit's PnL — the fills since the position's last alert.
  - **Flipped**: the closed side's result and the new side.
  - **Added / trimmed**: only once the size is 25% (`STEP`) from the size
    last alerted, so scaling in by small steps posts once it adds up.

  Opens and closes ping (owner 2026-10-08: "when a position is closed, tag
  me"); adds, trims and flips don't. A trader's first read sets the baseline; nothing
  posts for it.
- **What each card says** (owner 2026-10-08: "core information… condensed…
  a table format, each value clear"): a title line — kind, trader, coin and
  side, the headline number — coloured by kind (green open, blue add, amber
  trim, green/red close by result, purple flip), then ONE labeled table row
  (`alerts.ts` `table`, a header row over its values):
  - open: Lev · Entry · Size · %Acct · Liq · TP · SL;
  - add / trim: Added or Sold (dollars) · Price · Size · %Acct · Lev ·
    AvgEntry · P/L (open, on margin) · Held;
  - close: Entry · Exit · Move · Lev · P/L (on margin) · $P/L · %Acct · Held —
    the whole position since it opened, not the slice since the last alert;
  - flip: Closed · P/L · $P/L · New · Lev · Entry · Size · %Acct.

  Posted as an **image card** (owner 2026-10-08: "more polished"): the
  values in a real table — header row, grid lines, P/L coloured — drawn on
  the Mac mini by next's bundled @vercel/og (`scripts/perp-alert-card.ts`;
  measured ~3 ms a card, ~50 ms the first; no network, no tokens), uploaded
  with the post under the title line and the links. Discord has no tables
  in text; an image also doesn't wrap on a phone. If the image can't be
  drawn or Discord refuses it, the text table posts instead.
  The account value (`portfolio`) is read only when a card posts, kept 10
  minutes per trader. When a position was opened is known if the script
  saw it open. Otherwise it's found in the trader's latest 2,000 fills
  (`positionOpening`) at its first card and then kept; older than those
  fills, it reads "held over Nd".
- **Rate** (2026-10-07, last 7 days of the 22): 72 opened, 80 closed, so
  about 25–40 messages a day.
- **Cost**: 2 Hyperliquid weight per trader per poll (22 traders: about 88
  a minute of the Mac's 1,200). Per trader with a change, 20–160 more: the
  fills since the last alert, the account value, the orders for an open,
  and once per older position its opening. Free and keyless. One
  Supabase request an hour.
- **Safeguards**:
  - At most 10 messages per trader an hour; the rest are counted and posted
    as one "N more moves" line.
  - Posts are spaced 2 s apart (Discord allows ~30 a minute).
  - Every request times out after 15 s.
  - A failed read keeps the trader's last positions, so no false "closed".
  - A lock file allows one instance at a time; a second would post
    everything twice.
  - After the Mac sleeps, moves seen on waking say "seen late".
- **Checked 2026-10-07** (dry run, real data):
  - The script read all 22 traders and set the baseline.
  - #1's real INJ short shown as opened gave the right size, 6.1% of the
    account, entry, liquidation, TP $3 and no SL.
  - 0xa5fd's real ZRO close gave the scan's own exit ($2.272, +18.2%).
- **Not covered**: HIP-3 markets, like the page. Tracked trades get no
  separate feed: every followed trader's moves already post.

## Later (not built)

- HIP-3 markets.
- Hyperliquid's terms for the owner's region (still unchecked) matter
  before any trading.
