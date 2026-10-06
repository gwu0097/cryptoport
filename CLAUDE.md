@AGENTS.md

# CryptoPort — project guidance

Last verified against the code at commit `ea9e799` (2026-09-25). Every claim
below names a file or symbol so it can be checked; when you change the thing a
rule describes, update the rule in the same commit. The story behind a rule
lives in `docs/DECISIONS.md` (cited as `DECISIONS: <date> <title>`), not here.

## 1. Purpose

A multi-tenant, multi-chain crypto portfolio tracker: one place to see every
wallet and holding (**traceability** — where is my money), what changed
(**trackability**), and enough signal to make a buy/sell decision. Not a
trading platform, not a tax tool. Every feature serves traceability and
trackability first, and must work for users whose assets differ from the
owner's.

- **The Dashboard is a lens, not a workshop.** `/dashboard` only presents data
  other pages already compute (`AssetGroup`, `portfolio_snapshots`, …). If a
  Dashboard request needs a new metric, aggregation or data source, say so and
  build it as its own page first (Performance owns historical value math,
  Analytics owns derived analysis), then have the Dashboard consume it. (DECISIONS: before 2026-09-22 Dashboard is a
  lens)
- **The screener ("Fundamentals" in the UI) is a verified research dataset with
  a risk filter, not a signal.** No new capability until evidence supports it.
  Its spec, phases and rules live in `docs/screener/` (start with SPEC.md's
  "Product" section). `src/lib/screener/*` is never imported by portfolio code
  (wallets, holdings, watchlist); the Encyclopedia reads it only through
  `src/lib/screener/assetView.ts` (`getAssetFundamentals`) and
  `src/lib/screener/labels.ts`.
- **Analytics** (`/analytics`, `src/lib/analyticsQuery.ts` → pure
  `src/lib/analytics/`) reads only stored data, no external call: what moved
  the portfolio (`attribution.ts`; exact when the window's starting
  `wallet_snapshots` rows carry `assets` — each coin's quantity and price at
  that snapshot, written by `snapshots.ts` via `exactAttribution.ts`
  `walletComposition` — so price effect = quantity then × (price now − price
  then) and the rest is named per coin; while a window's own start day predates the
  coin-by-coin snapshots it starts at the first of them instead, labeled
  ("the last 5 days — the full 7D view starts Oct 4"), and with none at all
  it says it's still building — never an estimate in place of data (owner
  2026-10-02: an estimate's error landed in "everything else" on untouched
  wallets); one row per ticker —
  the same token on several chains summed, `mergeByTicker` — with the top 6
  each way and the rest behind a toggle, so the lists add up to the price
  figure), its risk (`risk.ts`: today's holdings over the last 90 days with
  daily prices, benchmarked to BTC's history; an asset without enough history
  is named as not modeled) and each holding's context (`holdingContext.ts`:
  fixed-threshold flags — observations, not advice).
- **Wallet Watch** (Tools → `/wallet-watch`, `docs/wallet-watch/PLAN.md`)
  follows other people's addresses — never part of the user's portfolio or
  any total. Up to 40 influencers per user (owner 2026-09-30; was 25), each
  with up to 5 addresses; groups are the user's own.
  One shared `watched_addresses` row per address (read once however many
  watch it; RLS: readable only by its watchers). Every snapshot write goes
  through `watchRefresh.ts` `refreshWatchedAddress`: the address is read
  with the sync's adapters (`lookup.ts` `fetchAddressHoldings`, the previous
  snapshot's tokens as `previous`, no Zerion), a failed source keeps its
  rows (`carryForward`), and the snapshot stores only what can matter to a
  movement (`watchSnapshot.ts` `buildSnapshot`: holdings ≥ $1, positions,
  anything stored last time; dust and spam only counted). Caps are a
  database trigger (`watch_enforce_caps`). Each read also records what
  changed since the last one (`watchDiff.ts`: only a quantity change of
  ≥ $100 and either ≥ 1% of the position or ≥ $5,000 is a movement; coins summed across chains; venue cash,
  kept rows, unpriced and illiquid coins never move), each position's life
  (`watchPositions.ts`, `watched_positions`) and the day's value
  (`watched_address_daily`). The daily read (2026-09-29, two Fable reviews):
  Supabase **pg_cron** calls `api/wallet-watch/tick` every minute 08:00–09:59
  UTC, only while an address someone watches is due (checked inside
  Postgres — a finished run costs nothing; URL and `CRON_SECRET` in Supabase
  Vault as `cryptoport_site_url` / `cryptoport_cron_secret`). The first tick
  of the day runs one batched pricing pass and the retention trim
  (`app_settings` `wallet_watch_run`); every tick fills each lane's free
  slots (`watchReadQueue.ts` `freeSlots`: EVM ×2, Solana ×1, other ×1) with
  one `api/wallet-watch/read` call each, which claims one due address
  (`claimNextInLane`), reads it and **stops**. Never chain calls to our own
  site: Vercel answers HTTP 508 (loop detected) after ~4 hops (seen live).
  An address whose claim died in the last 2 h killed its read (> 300 s): it's
  marked failed and waits for tomorrow. Each read logs a `[watch-read]` line
  with its step times and slowest chains; ticks and reads log their hop depth.
  **Watch Insights** (Tools → `/watch-insights`, `watchInsightsQuery.ts` →
  pure `watchInsights.ts`) compares a group: coins at least two of them
  bought in the window, coins at least two hold now (≥ 0.5% of each wallet),
  net flows, the user's own coins they moved, and per influencer the value
  and cash-like share over the window and a track record counting only
  positions opened since watching (never held-at-start ones). Observations,
  not signals.
  The Dashboard shows the same feed at its bottom (`DashboardWatchActivity`,
  filtered by group in the browser), loaded with `getWatchFeedTargets` —
  no snapshots, so a Dashboard view doesn't pull them.
  Each token line shows the coin's price now (`asset_prices`, only when
  priced after the move) and its change since the trade's price; Refresh
  prices includes every coin traded in the last 7 days
  (`assetPrices.ts` `allHeldKeys`), in the same batched calls.
  **Activity check** (phase 4, on demand — "Refresh activity" on the
  Dashboard panel and Wallet Watch): each address's transactions since its
  last check (`api/wallet-watch/check` streams per address, no polling;
  sources `adapters/watchActivitySources.ts` — Helius parsed transactions,
  Alchemy transfers, Blockstream; venues aren't checked), reduced to each
  coin's net change per transaction (`watchActivity.ts`: swap / transfer /
  "unclear" where Alchemy can't see a router's native payout — it can only
  on eth, base, matic) and shown per coin like a trading app's token card
  (`coinDays`: buys and sells with what was paid in SOL/USDC/ETH, still
  held, the result of what was bought and sold today; each trade behind a
  toggle; prices shown as the market cap at that price — circulating
  supply = the stored market cap ÷ price, which the Jupiter lane now stores
  too — else the price; a coin row's refresh icon gets just that coin's
  price, `api/wallet-watch/coin-price`, one call to its source, skipped
  within 10 s (a double click), and a sold-out row then shows "MC now", owner
  2026-09-29). Cash coins are only the payment side, never a row (owner
  2026-09-28: match KOLScan's per-trade view). For every trader alike, the
  coins they've sold out of (a leftover under $1 counts) fold into one row;
  only open positions keep their own (`activityFold.ts`; owner 2026-09-30 — the most recent coin no longer stays out once sold). Saved on `watched_addresses`
  (`tx_activity` appended, `tx_cursor` per source) until the next read,
  whose start (`snapshot.readStartedAt`) is the day's boundary and which
  drops older legs (`trimToBoundary`). The view never reaches back past
  today's 08:00 UTC read time, even when the read didn't get to an address
  (`rebaseToDay` in `getWatchDayActivity`: older legs left out, starting
  quantities moved forward; nothing deleted). An address checked in the last
  15 minutes is reused (`CHECK_REUSE_MS`, Helius credits).
  **Live updates** (phase 5, owner-only switch per influencer, Solana): one
  app-owned Helius "raw" webhook (`webhookSync.ts`: created/updated/deleted
  to match `watched_addresses.live`, 100 credits per change; 1 per delivered
  transaction) POSTs to `api/wallet-watch/webhook` (checks the
  `HELIUS_WEBHOOK_SECRET` Authorization header). Both receivers acknowledge
  (200) a delivery they can't save — an error makes Helius/Alchemy retry, and
  during a Supabase outage (2026-10-01) the retries became a storm that burned
  credits and stalled every page; what isn't saved is found by Refresh
  activity and the morning read. One live-list read per instance (in flight
  shared, last list kept on error). A circuit breaker (`dbBreaker.ts`): 3
  database failures in a minute and the receivers skip the database for a
  minute, just acknowledging. Helius charges 1 credit per transaction sent
  (retries free); a raw webhook can't filter to swaps (only enhanced ones can),
  and an enhanced SWAP-only filter was measured and rejected (2026-10-02, 2,759
  transactions of the 14 live wallets): 34% are trades, but Helius labels only
  63% of those SWAP — bot and router trades come as TRANSFER/UNKNOWN, the same
  labels as the spam, so no type filter separates them.
  **Bot guard** (owner 2026-10-02 — a bot address, Notdecu, ~2,900
  transactions a minute and none a trade we keep, used ~577K of Helius's 1M
  monthly credits in hours). Judged on a day, never a minute (owner: traders
  burst, then stop; measured, Risk made 3,577 in 24 h, busiest hour 646):
  - Going live: the address's last 24 hours are counted — Solana on the free
    public RPC (`adapters/solanaActivityRate.ts`), EVM on Alchemy
    (`adapters/evmActivityRate.ts`) — over `LIVE_DAY_MAX` (10,000) or
    unknown, it stays off (`liveBudget.ts`).
  - While live, each receiver counts deliveries per address
    (`deliveryCounter.ts`, per instance): 60 trades or 600 transactions in a
    minute stop it at once; 2,000 in an hour has its day checked
    (`liveBotGuard.ts` `turnLiveOff` / `checkSuspect`) — off the database and
    the provider's webhook, with a Discord message.
  - Removing an address or influencer (and the tick's unsaved-search
    expiry, and Wallet search's trim) releases addresses nobody watches any
    more from live and the providers' webhooks (`releaseUnwatched`) — a
    removed address used to stay live with no switch left (audit 2026-10-02).
  - The morning tick's first run sweeps the live set (`sweepLive`): unwatched
    or over-the-day-limit addresses off, both providers' webhooks synced to
    the database (100 Helius credits), one Discord line with each live
    address's 24-hour count. A failed turn-off posts a 🚨 alarm. It also checks that
    each provider still delivers (`webhookHealth.ts`): Helius and Alchemy
    switch a webhook off on their own after a day of failed deliveries — both
    did while Vercel had paused the site (2026-10-02) and the alerts went
    quiet unnoticed — so a webhook found off posts a 🚨 line (Helius's state
    comes back with the update it gets anyway; Alchemy's from one free
    `team-webhooks` call). Re-enabling is a click in that provider's dashboard.
  - The webhook, tick, read and cron routes skip `proxy.ts` (they check
    their own secret) — each delivery paid a second invocation there. A
    failed morning read waits until tomorrow (`next_refresh_at` + 20 h), not
    the next tick. Alerts and the live broadcast run after the receiver's
    response. Delivery counters are 10-second buckets.
  - Each trading record load counts the address's day too
    (`activity24h` on the record): over the limit, the influencer page opens
    with a red "This looks like a bot" banner (owner 2026-10-02). Trade
    counts alone don't separate (Risk ~240 trades a day, Notdecu ~480). `webhookTx.ts` reduces a raw
  transaction exactly as `readSolana` does (checked on 4 real trades);
  spam that only arrives is dropped before any request (`worthSaving`); a token moved by ≤ 10 base units (a coin the route passed through) is no leg, in both Solana reductions (`isRouteResidue` — as a third leg it left buys unsized); legs
  are appended to `tx_activity` tagged `source: "webhook"` — every write of
  `tx_activity` (webhook, Refresh activity, the morning read's trim) goes
  through `txActivityStore.ts`, a compare-and-set on `tx_version` with retry;
  a read-modify-write lost trades when two deliveries landed in the same
  second (Risk, 2026-09-28) — without moving
  the cursor, so Refresh activity still reads the history and reports
  "webhook missed N" for live wallets (the running discrepancy check).
  **EVM** (phase 6): the same switch puts an influencer's EVM addresses on
  the app's Alchemy Address Activity webhooks — one per network, Ethereum,
  Arbitrum and Robinhood Chain (`alchemyWebhookTx.ts` `WEBHOOK_NETWORKS`;
  every live address on all three), kept in step by
  `alchemyWebhookSync.ts` (Notify API, `ALCHEMY_NOTIFY_TOKEN`; ids and
  signing keys in `app_settings` `alchemy_webhooks`). Deliveries POST to
  `api/wallet-watch/evm-webhook`, verified by `X-Alchemy-Signature` (HMAC of
  the raw body with that webhook's key); `alchemyChanges` reduces them as
  `readEvmChain` does, with the router's ETH payout (internal transfers,
  delivered on all three) so no leg is "unclear". On an EVM row "webhook
  missed" counts only those three networks.
  Turning it on only works from the deployed site (the providers need a public URL).
  **Discord alerts** (owner 2026-09-28): every live delivery that adds legs
  is compared before/after with `coinDays` (`watchAlerts.ts`, pure) and
  posts only a change, never per transaction — opened (not held at the
  read, today's buys reach `ALERT_MIN_USD` $100; pings once its buys reach
  `PING_POSITION_USD` $200 — owner 2026-09-29, was $500 — at once or as "is building"), a new burst of buying
  (buys under `BURST_GAP_MS`, an hour, apart are one burst; a later burst,
  or the first buys today of a coin held at the read, posts at $100), added (today's buys cross
  `ADD_STEPS_USD` $1K/5K/10K…), closed (worth under $1 now; owner 2026-09-30: a win/loss card — ✅ green or ❌ red, "closed X · +12.6%" in the title, the result as a heading (dollars, else the coin paid with, `exitReturnPct`), In → Out, exit, how long held; "result unknown" when part was held before today — `closeDetail`; with a PnL image drawn by `next/og` in the same function and uploaded with the post, `closeCardImage.tsx`; the card's text is then only the title and the contract — no extra request, no public endpoint, only the bundled font, so its text is cut to Latin letters: an emoji or other script would make it fetch one from the web), trimmed
  (`TRIM_STEPS` 25/50/75% of the position) — to `DISCORD_WATCH_WEBHOOK_URL`
  (`watchAlertSend.ts` → `adapters/discordWebhook.ts`, as cards — `alertEmbed`:
  coloured by kind, the title linked to the coin on Fomo (Solana) or
  DexScreener (EVM), CryptoPort linked on an open only, and on every card "Wallet trades" beside the contract — Solscan's DeFi activities (Solana) or DeBank's history (EVM), `walletTradesLink`, owner 2026-09-30; the only ping of
  `DISCORD_WATCH_ROLE_ID` is a position opened today reaching $200 — owner
  2026-09-29: "rest is noise"; a sell-out within the hour of opening says
  it was a flip; nobody else is ever pinged).
  **Liquidity at entry** (owner 2026-09-30: only the initial figure): when a
  live delivery opens a position — a coin not held at the read whose buys
  reach $100 with it, the "opened" alert's moment (`entryLiquidity.ts`
  `openingLegs`) — the coin's liquidity is asked once and saved on that
  buy (`entryLiqUsd`): Solana from Jupiter (the call the alert made for the
  supply anyway — it reuses the answer), EVM from GeckoTerminal (one call
  per chain for every coin opened, `adapters/geckoTerminal.ts`; its market
  cap gives the alert's supply too). Shown as "avg entry MC $X · Liq $Y" and
  on the opened alert; trades found by Refresh activity or the morning read
  have none (a past liquidity can't be looked up).
  Every card shows the market cap at its price (owner 2026-09-29) — the
  coin's circulating supply × the trade price: Jupiter's `circSupply` for a
  Solana mint (one call per post, only when something posts), else
  `asset_prices` market cap ÷ price; no supply, no market cap shown. A sale
  says what it was sold into, for how much and at what price ("received
  4.12 SOL ($490.10) at $0.0000142 · MC $14.2K"), then the result. One request
  for the trader's name, only when there's something to post; a failure is
  logged, never fails the delivery; a retried delivery adds no legs, so it
  can't post twice. Refresh activity doesn't post.
  Open pages update by themselves: after a delivery adds a new line, the
  receiver sends one empty Supabase Realtime broadcast (`liveBroadcast.ts`,
  channel in `liveChannel.ts`); an activity panel showing a live influencer
  listens (`DayActivity` `useLiveDay` → `liveListener.ts`, one shared
  channel per tab kept open for its life — a channel per panel, removed and
  re-joined on navigation, silently stopped receiving; the only browser
  Supabase client is `supabaseBrowser.ts`) and fetches just its lines from
  `api/wallet-watch/day` (~4 requests). How soon is the viewer's
  **Watching** switch (owner 2026-09-28, `liveWatching.ts`, `useWatching.ts`
  — kept in the browser, shared by every panel): on, about a second after a
  delivery (at most every 15 s), turning itself off after an hour; off, at
  most every 30 minutes. Background tabs alike. The endpoint reads
  `asset_prices` with the service role (before 2026-09-29 the user's client
  was denied it; that 500 kept every live update from showing, 2026-09-28).
  No polling; panels without live influencers don't listen.
  **Activity backfill** (an influencer's page; owner 2026-09-29: the
  Activity list is every transaction on every address): "Backfill 7 / 30
  days" (`BackfillButtons` → `api/wallet-watch/backfill` →
  `watchHistoryLoad.ts` `backfillActivity`) writes the lines a morning read
  would have written for each day before an address was first read
  (`created_at`) — per coin per day, net change, judged by `moveKind`,
  sized at that day's close else its trade prices (pure `watchBackfill.ts`)
  — as `watched_movements` rows with `source = 'transactions'`, replaced on
  each run. Days after the first read are the real reads' lines. EVM and
  Solana alike (Solana only for the owner: Helius credits, `SOLANA_PAGES`);
  the Solana trading record below is a year of PnL, not transactions, and
  stays separate. Each line names its wallet when an influencer has several.
  The trades read are kept on the watched address (`trade_history`, 30
  days, `HISTORY_KEEP_DAYS`): a backfill reads only what isn't stored — per
  chain, newer transfers from the last read's end, older days up to the
  stored oldest end (`planHistoryReads`, `extendCoverage`; a chain read in
  the last 15 minutes isn't read again) — one leg per transaction and coin
  (`mergeHistoryLegs`); the morning read adds the day's legs it trims
  (`watchRefresh.ts` `keepInHistory`). Swaps are sized at the paying coin's
  close that day (a stablecoin: $1); a coin-for-coin swap at the coins'
  stored prices (`toLegs` `storedValueOf`, legs marked `sizedBy`). EVM reads
  go up to 20 pages per direction (`HISTORY_PAGES`). A chain that hits the
  page cap covers only back to its oldest transfer; one that fails claims
  nothing; both are named. Unpriced coins traded get one batched
  `ensureAssetPrices`, as in Refresh activity.
  **EVM trading record** (owner 2026-09-30, Robinhood Chain first): the same
  panel from Zerion's profit and loss (`adapters/zerionDefi.ts`
  `fetchZerionPnl`, pure `zerionRecord.ts`): all-time, 30/90 days and each
  of the past 12 months (`since`/`till`) — 15 calls an address the first
  load, then all-time, the windows and the running month (a month stored
  before it ended is asked once more); 1.1 s apart, all-time first — a
  wallet Zerion is still preparing (503) stops there with "try again in a
  minute" — and no more after 75 s (the rest asked next load; the route
  has 120 s, and a first load of a new wallet once ran past it). Totals only — no coin
  list, win rate or best day; instead, from the all-time answer, the return
  on coins sold, fees paid, and the biggest fall of month-end realized
  profit (`monthDrop`) — no extra call; a window Zerion can't answer (over
  3,000 transactions from its nearest mark) is "—", never 0. Rebuilding it
  from transfers was tried and dropped: on Robinhood Chain most trades are
  coin-for-coin, which daily prices can't value (BACKLOG).
  **Trading record** (an influencer's page, Solana addresses): "Load
  trading record" pulls each address's profit and loss from Solana Tracker in
  USD — 2 requests (all-time summary + the past 365 days by day,
  `adapters/solanaTracker.ts`), reused for an hour (`tradingRecordLoad.ts`),
  stored on `watched_addresses.trading_record` and summarized by pure
  `tradingRecord.ts` (months, 30/90 days, best month's and day's share of
  the year). Its coins (hover a month: biggest gains and losses, with copy
  buttons) come from the positions endpoint newest-first: a year the first
  time (Hash: 22 requests, 1,780 coins, 144 KB), then only coins traded
  since `coins.cursor` (a refresh: 3 requests); a coin counts once, in the
  month it was last sold (`mergeCoins`). Never automatic: Helius history scans cost ~3,300–7,700
  credits per busy wallet-month, this costs 2 of 2,500 monthly requests.
  **Sharing:** an influencer's owner can share it
  (`watch_influencers.share_token`, a random UUID; null = not shared) at
  `/wallet-watch/shared/<token>` — any signed-in user sees it read-only
  (`watchQuery.ts` `getSharedInfluencer` reads with the service role only
  after the token matches; the owner's note and groups are never included)
  and can copy it into their own list. A copy records its source
  (`watch_influencers.copied_from`) and follows it: an address the sharer
  adds or removes is added to or removed from every copy while the source
  is shared (`watchCopySync.ts`, from `watchAddress`/`removeWatchedAddress`;
  only the change, so a copier's own additions and removals stay; copies of
  copies too). "Stop following" on the copy ends it; an influencer the user
  created follows nothing.
  **The list is managed in place** (owner 2026-09-30, like the Wallets
  list; `WatchTable`): rename (`InlineName`), group chips (`GroupChips`),
  the owner's Live switch, delete per row or the ticked rows together
  (`removeInfluencers`); live state rides on the list's own read
  (`WATCHED_COLUMNS` `live`). The group last picked is remembered in a
  cookie (`watchGroupCookie.ts`): a link naming no group opens it; All is
  `?group=all`.
  **Wallet search** (owner 2026-09-30; the search bar in Wallet Watch's
  header, `WalletSearch` → `searchWallet`): an address opens on the
  influencer page exactly as if watched (read now, trading record a click
  away) as an influencer with `unsaved_since` set and its short address as
  the name — left out of the list, groups, Insights and the Dashboard feed
  (`readWatchBase`, `getWatchFeedTargets`), listed as "Recent searches";
  naming it saves it (`renameInfluencer`, within the 40); the daily tick
  deletes unsaved ones after 10 days; a user keeps 10, a new one replacing
  the oldest — never blocked (the owner keeps all; the trigger's backstop
  is 200). An
  address already watched opens its own page.
  **Shared groups** (owner 2026-09-30, `docs/wallet-watch/SHARED_GROUPS.md`,
  Fable-reviewed): a group's creator shares it (`shareGroup`, invite link
  `/wallet-watch/join/<token>` → `join_watch_group`); members
  (`watch_group_members`, ≤ 20) see the same group and every influencer
  in it, add their own, take any out. Visibility is RLS through two
  security-definer functions (`watch_my_groups`, `watch_visible_influencers`)
  on the influencer, address and every `watched_*` table. Only an
  influencer's creator edits it: RLS makes a non-owner's update match no row
  silently, so every owner-only write filters `user_id` and checks a row
  came back (`NOT_YOURS`); the UI hides those controls (`mine`). Leaving,
  removing a member or stopping sharing takes that person's wallets out of
  the group (they stay theirs). Members' names: `watch_group_people` (the
  email before the @, to co-members only).
  **KOL directory** (Tools → `/wallet-watch/directory`,
  `docs/wallet-watch/DIRECTORY.md`): the owner's influencers marked for it
  (`watch_directory`, service role only — `setInDirectory`, `requireAdmin`;
  an entry is always shared). Any user adds one as a following copy
  (`addSharedInfluencer`) or keeps their own; only the owner edits entries.
  Any user can suggest a wallet for a directory KOL ("Suggest a wallet",
  `suggestWallet`; `watch_suggestions`, users insert pending ones and read
  their own — `in_watch_directory` checks the entry; 20 waiting at most);
  it reaches nobody until the owner approves it in Owner's console → KOL
  suggestions, after "Check links" (`checkSuggestion` → `adapters/
  walletLinkReads.ts`, pure `walletLinks.ts`: transfers between it and the
  KOL's known wallets — both ways and ≥ 3 is "linked", one-way proves
  nothing). Approving adds it to the KOL and every copy (`decideSuggestion`).
  Linked-wallet suggestions from the daily reads are phase 3. The address
  lookup (`/lookup`) is
  public; lookup links need no account.
- **Perp Scout** (Tools → `/perp-scout`, `docs/perp-scout/PLAN.md`; owner
  2026-10-06): followed Hyperliquid traders' open positions and where price
  is against their entry — observations, not signals; nothing is copied or
  traded. **The list is curated in chat, not by the app** (owner: "I'm
  asking you to find them for me, then just add it to the list"):
  `src/lib/perpScout/followed.ts` `FOLLOWED`, each with why and the figures
  it was picked on. Candidates come from `scripts/diag/perp-scout-screen.mts`
  (pure `perpScout/screen.ts` + `portfolio.ts`: leaderboard $50K–$20M,
  all-time PnL ≥ $100K and ROI ≥ 50%, 30d profitable, monthly volume ≤ 60×
  equity; then the **perps** record only — ≥ 5× turnover, traded this month,
  ≥ 26 weeks, drawdown on the PnL curve ≤ typical equity, best 4 weeks ≤
  80% of profit, ≤ 90% winning weeks; the first live screen's picks had
  100% winning weeks, no perp positions and ROI +995,700%). Scan
  (`api/perp-scout/scan`, streamed → `perpScoutScan.ts` `runScan`) reads
  each listed trader's main-market positions, latest 2,000 fills (when each
  was opened and at what price, `perpScout/entries.ts` `positionOpening`)
  and TP/SL orders into one shared `app_settings` row (`perp_scout`; one
  scan at a time, `perp_scout_run`); a trader not read keeps last scan's
  entries. Calls go through one weight pacer per instance
  (`perpScout/pacer.ts`, 1,000 of the IP's 1,200 a minute). Refresh prices
  is one `allMids` call, not stored.
- Signals / SMC (`src/lib/signals`, `src/lib/smc`) are pre-registered research
  (`docs/signals/`), not trading. Auto-trading is backlog and gets its own plan.

## 2. Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` (port 3000 may belong to an unrelated server — pass `-p <port>`; never `pkill -f`, stop by PID: `lsof -ti:<port> -sTCP:LISTEN \| xargs kill`) |
| Type check | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| Unit tests | `npm test` (= `node --conditions=react-server --test`) |
| Production build | `npm run build` |
| SQL schema check | `node scripts/check-sql-schema.mts <file.sql>` (exit 1 on anything outside `cryptoport`) |
| Screener schema preflight | `node scripts/check-screener-schema.mjs` |
| Portfolio totals regression | `scripts/diag/portfolio-totals.ts save <f.json>` then `compare <f.json>` |

**Verification gate before every push:** tsc, lint, test; `npm run build` for
changes to routes, config or dependencies; the screener preflight for anything
touching screener code or its tables.

**Diag/one-off scripts** (`scripts/diag/`): tsx is not a project dependency —
use a cached copy (`ls ~/.npm/_npx/*/node_modules/.bin/tsx`) with
`NODE_OPTIONS="--conditions=react-server"`, and load `.env.local` before a
dynamic `import()` of anything touching `src/lib/supabase.ts` (see
`scripts/diag/portfolio-totals.ts`). Under tsx wrap the body in `main()` — tsx
compiles `.ts` as CommonJS, so top-level `await` needs a `.mts` file (or plain
`node` with relative `.ts` imports only). `src/lib/queries.ts` can't be imported
outside Next (its `auth.ts` import pulls in `next/navigation`) — read tables with
`serviceDb()` directly. Only real tests may match `node --test`'s discovery:
`*.test.ts`, `*_test.ts`, `*-test.ts`, `test-*.ts`, `test.ts`, or any file in a
`test/` directory — name scripts accordingly. Keep a diag script only if
it's read-only and reusable (arguments, not hard-coded ids); delete one-offs;
never leave a destructive script anywhere.

## 3. Directory map

- `src/app/(app)/` — the app's pages (the nav list is
  `components/layout/navItems.tsx`). Every page renders per request and is
  viewable as a guest, except `admin` — "Owner's console" in the UI
  (`requireAdmin()` in `src/lib/adminAuth.ts` → `notFound()` for anyone but
  `ADMIN_EMAIL`): one tab per feature (`admin/layout.tsx`,
  `components/admin/OwnerConsoleTabs.tsx`) — Users (`/admin/users`, each
  user read-only at `/admin/users/<id>`), API list, Pricing coverage.
  `wallets/actions.ts` holds the sync and price-refresh actions. Also
  `src/app/(auth)/` (sign-in) and `src/app/lookup/` (public address lookup).
- `src/app/api/` — `cron/{snapshot,screener-snapshot,token-registry}`, `wallet-watch/{tick,read}` (pg_cron, Supabase) (schedules
  in `vercel.json`, gated by `Authorization: Bearer $CRON_SECRET`),
  `job-status` (what `JobPoller` polls), `tv-symbol` (a route handler rather
  than a Server Action so it doesn't wait in the action queue, §6).
- `src/lib/` — pure logic (one concern per file, with a sibling `.test.ts`) plus
  the data layer (untested directly): `queries.ts` (page reads), `supabase.ts`
  (`serviceDb()` service role — shared tables, crons, admin only; `userDb()` —
  anything per-user, RLS applies), `auth.ts` (`getUser`, `requireUser`).
  Sign-in is checked with `auth.getClaims()` (the token's signature,
  verified locally against the project's ES256 key), in `getUser` and
  `proxy.ts` — never `auth.getUser()` per request (a call to Supabase Auth
  each time, ~60% of the project's log volume) and never `getSession()` for
  a decision.
- `src/lib/adapters/` — one file per external source or chain (network code):
  EVM (`evm.ts` → `multicallEvm.ts`, chain list `evmChains.ts`), non-EVM
  (`nonEvmChains.ts`, `nonEvmDispatch.ts`), DeFi (`zerionDefi.ts` plus
  per-protocol files), pricing (`assetPrices.ts`, `assetKeys.ts`,
  `exchangeTickers.ts`), HTTP plumbing (`http.ts`, `coingeckoFetch.ts`,
  `jupiterFetch.ts`). Exchanges dispatch from `src/lib/exchangeAdapters.ts`.
  Where a topic has both halves, the pure part lives in `src/lib/` under the
  same name (`cosmosMulti.ts`, `exchangeTickers.ts`).
- `src/components/` — `ui/` (shared primitives), `jobs/` (background-job UI),
  per-page folders.
- `db/schema.sql` — checked-in documentation of the live schema (there is no
  migration tool; see §8). `scripts/` — schema checks, screener jobs, `diag/`,
  `launchd/` (the owner's local archive jobs).
- `docs/` — `DECISIONS.md` (why), `pricing/PLAN.md`, `screener/`, `signals/`.
  `BACKLOG.md` (repo root) is the committed backlog; read it before starting
  anything that might already be planned.

Env var names (values only in `.env.local` / Vercel): `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SITE_URL`, `COINGECKO_API_KEY`, `COINGECKO_API_KEY_BACKUP`,
`ETHERSCAN_API_KEY`, `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `ZERION_API_KEY`,
`JUPITER_API_KEY`, `PERPLEXITY_API_KEY`, `SOLANA_TRACKER_API_KEY`, `HELIUS_WEBHOOK_SECRET`, `ALCHEMY_NOTIFY_TOKEN`, `DISCORD_WATCH_WEBHOOK_URL`, `DISCORD_WATCH_ROLE_ID`, `SECRETS_ENCRYPTION_KEY`,
`ADMIN_EMAIL`, `CRON_SECRET` (Vercel only); scripts only:
`SCREENER_ARCHIVE_DIR`, `SIGNALS_ARCHIVE_DIR`.

## 4. Data invariants — these must never break

### 4.1 Unknown is never 0

A missing value is **unknown**, never silently 0 and never a plausible-looking
wrong number. `valuation.ts`'s `Valuation` union (`{kind:"unpriced"}` vs
`{kind:"priced"}`) makes "forgot to handle missing data" a type error.
Unpriced holdings are counted and named, never dropped from totals silently;
averages (`blendedChange`) exclude missing inputs rather than treating them as
flat; the UI shows `—` or an explicit warning. Never fabricate placeholder data,
for guests included (§7).

### 4.2 Pricing: one price per asset

**Debugging a missing or stale value:** check the holding's `price_key`, then
that key's `asset_prices` row, then the latest `pricing_runs` row. Verify any
pricing change with `scripts/diag/portfolio-totals.ts save`/`compare`.

**Identity.** Every holding carries a `price_key`: the one asset it is — a
CoinGecko coin id, or `jup:<mint>` / `hl:<TOKEN>` / `coinbase:<TICKER>` /
`fiat:USD` for what CoinGecko doesn't list. `resolvePriceKey`
(`src/lib/assetIdentity.ts`; lookup tables loaded by `adapters/assetKeys.ts`
`withPriceKeys`) sets it at sync time:
- manual dollar entries and position values (`isPositionValue`) get none;
- then, in order: `asset_contracts` overrides; the row's own coin (Cosmos
  registry id, a manual pick); an exchange's fixed coins (`CANONICAL_EXCHANGE`,
  `NATIVE_BY_SYMBOL`); the venue's ticker map (`exchange_assets`) — an unmapped
  venue ticker tries `krakenStakedBase`, then becomes `coinbase:<T>` / `hl:<T>`,
  else stays unpriced; a contract via `token_registry` (CoinGecko's
  contract→coin list), with Solana falling back to `jup:<mint>`; the chain's own
  native coin (`nativeKey`, which also covers `PROTOCOL_COINS` and venue natives).
- **Never an open-ended ticker lookup.** The only ticker matches are those fixed
  sets and a chain's own native symbol; no match means unpriced.
- **Bridged and wrapped copies are their own assets** (WETH, USDC.e, axlUSDC,
  Gravity USDT). Combining liquid staking tokens with their base coin is a
  display toggle (`liquidStaking.ts`), never a price rule. A registry that maps
  a bridged copy onto the real coin (Keplr does) is not trusted for that asset
  (`registryAssetInfo`, `src/lib/cosmosMulti.ts`).

**Prices.** `asset_prices` holds one price per key plus its `change_*` and
`market_cap` columns, filled by `refreshAssetPrices` (`adapters/assetPrices.ts`)
in one lane per source — coingecko, jupiter, hyperliquid, coinbase — with
`fiat:USD` fixed at $1. When CoinGecko fails (2026-09-29: its CloudFront
refused the long 250-id queries), the same ids are priced from DefiLlama
(`adapters/llamaPrices.ts`: price and 24h change, serial calls 1.5 s apart;
market cap and volume keep their stored values — rows are saved in groups
of the same columns, since an upsert nulls a column a row lacks). A price is **never overwritten with null**
(`planPriceWrites` in `assetPriceWrites.ts` sets `missing_since` instead). Each
pass is logged to `pricing_runs` (keys requested/returned/missing, calls per
source).

**Refresh triggers** (owner decision: on demand, no periodic refresh): the
Refresh prices button; after a sync, only the keys it touched
(`ensureAssetPrices`, which skips keys priced *or tried* within its `maxAgeMs`
default — 453 keys no source prices used to trigger a pass on every read);
before a Sync all when the newest price is older than `primeSyncPricesAction`'s
threshold; the user's **Auto-sync daily** wallets (owner 2026-09-30, `autoSync.ts`,
the wallet page's `AutoSyncToggle`, at most `AUTO_SYNC_MAX` 5): Refresh prices
returns the marked ones not synced in a day and the button hands them to
the browser's sync queue after the prices — the click isn't slowed, no
cron runs, the tab doesn't ask before closing (a wallet not reached is
still due next time; Sync all still asks), and Sync by hand is unchanged
(it resets the day); before the daily snapshot when older than the threshold in
`api/cron/snapshot/route.ts` (`refreshAssetPricesIfOlderThan`).

**Valuation** (`valueHolding`, `valuation.ts`): `qty × asset_prices[price_key]`,
else the row's stored `usd_override`, else unpriced. `usd_override` is for
position values a protocol computes (LP, perps, Kamino, prediction shares,
vaults) and manual dollar entries. No sync path prices a coin row from the
app's own price tables. Some protocol adapters still stamp the source's own
valuation on coin rows — `zerionDefi.ts`, `naviPositions.ts`,
`jupiterPositions.ts` (limit orders) — and `valueHolding` uses it only when the
row's key has no price. **An illiquid holding is shown but not counted** (owner decision
2026-09-26, `liquidity.ts`, docs/pricing/ILLIQUID.md): worth more than its
coin's 24h volume and more than 5% of its market cap (with no market cap:
more than 10× that volume), at ≥ $1,000. `getPriceMap` attaches each coin's volume and market cap
(`withLiquidity`), so `valueHolding` returns `{kind:"unpriced",
reason:"illiquid", nominalUsd}` on every page alike; the tables label it
"illiquid". Only CoinGecko-priced coins can be flagged.
**A $1-per-unit value is allowed only for the
stablecoins in `src/lib/stablecoinFallback.ts`** (Hyperliquid and Polymarket
dollar balances), as a last resort; any other coin without a price shows "—".
**Open perp positions' live PnL is display only** (`perpPositions.ts`). A
position is valued at its margin (`usd_override`) in every total; on
Hyperliquid the account's cash already moves with PnL, so PnL is never added.
Refresh prices stores the venue's mark under `hlperp:<COIN>` (Hyperliquid) or
`lighterperp:<SYMBOL>` (Lighter) — only while a position on that venue is
open, one call per venue; a new venue is an entry in `perpPositions.ts`
`MARK_PREFIX` plus its lane in `adapters/assetPrices.ts`. The position's
Price column is that mark ("—" without one: margin ÷ size isn't a price).
Every holdings read shows
size × (mark − entry) when that mark is newer than the wallet's sync
(`withCurrentPnl` in `getWalletDetail` / `getActiveWalletsWithHoldings`), and
the Dashboard's Open positions section lists them, with Polymarket positions
still worth something (`isOpenPosition`). Its **Refresh positions** button
(`api/positions/refresh` → `positionsRefresh.ts`) re-reads only the venue
accounts with an open position, or one in the last 30 days
(`venuesToRefresh`, `wallet_venue_activity`, written by every sync and
refresh that sees a position) (`POSITION_VENUES`: Hyperliquid incl. its HIP-3 markets, Lighter, Aster,
Polymarket, Jupiter Perps, Jupiter Prediction — one call each) and replaces
that venue's rows for the wallet (`replace_venue_holdings`, narrowed by
protocol on a shared chain), cash and margin included, so totals stay right;
no chain scan, no price refresh, and the wallet's `last_refresh_at` is left
alone. It streams: every account is read at once and each one's positions are
sent as one NDJSON line the moment it's saved, so the section's rows and
totals update account by account (`OpenPositionsPanel` `streamRefresh`), then
`router.refresh()` re-renders the page. Whether a mark is newer is judged per row (`holdings.updated_at`). Each
position also carries its TP/SL orders (`holdings.position_tpsl`, `tpsl.ts`):
Hyperliquid's reduce-only trigger orders (read only for markets with a
position) and Jupiter Perps' tpslRequests; `[]` = none set, null = not known
(Lighter's orders need the account's API token).

**A receipt token and its protocol position count once** (`receiptDedupe.ts`,
`dedupeReceipts`). A liquid staking or vault receipt (MaticX, eETH) that the
wallet holds is the same money as the Zerion position whose `pool_contract` is
that token. If the token is tradable (`asset_prices.volume_24h` ≥
`TRADABLE_MIN_VOLUME_USD`) the wallet token stays and the position is dropped;
if not, the position stays (where it's staked, how to withdraw) and the wallet
copy is dropped. Both lists come from the same sync (§4.4), so the check always
runs on fresh data from both sides. When Zerion's `pool_contract` doesn't name
the held token (Morpho vaults have none; Aave's is the lending pool, not the
aToken), the position is linked by reading the token on-chain through its
standard interface — ERC-4626, Aave aToken, Compound v3/v2
(`adapters/receiptTokens.ts` → `linkReceiptPositions`): same coin, same amount
within `RECEIPT_MATCH_TOLERANCE`, exactly one match — otherwise both stay. A new
receipt standard is added there, not special-cased per protocol.

**A receipt CoinGecko doesn't list is valued as its underlying coin** (owner
decision 2026-09-25): when a held EVM token has no price of its own but reads
as a standard receipt, the row stores the underlying amount, `coingecko_id` =
the underlying coin (its `price_key`) and a label like "hUSDB (as USDB)"
(`multicallEvm.ts` `priceScans`, `tokenDiscovery.ts` `classifyHeld`). Such a row
is never tradable for the dedupe above: the underlying's volume says nothing
about the receipt's own market, so its position stays when Zerion has one. A
debt token (Aave variable/stable debt — it answers `borrowAllowance`) is never
read as a receipt: a loan is not a holding (`receiptTokens.ts`). One
function is never proof of a receipt: each standard needs a second answer
only it gives, and a claim can't exceed the underlying's total supply or a
vault's `totalAssets` (`receiptChecks.ts`; a meme token answering Comet's
`baseToken()` was valued at $236K, docs/pricing/ILLIQUID.md).

**Resolution must work for assets the owner doesn't hold.** Exchange tickers
come from CoinGecko's per-exchange data, refreshed weekly
(`adapters/exchangeTickers.ts` `refreshExchangeAssetsIfStale`; rows with
`mapping_source` `manual` or `coinbase-registry` are kept); Kraken staking codes
resolve by Kraken's naming (`krakenStakedBase`); Cosmos `ibc/…` tokens are
traced over IBC to their home chain's registry entry (`adapters/cosmosMulti.ts`);
the token list refreshes weekly and when a Solana/Sui sync meets an unknown
token (`tokenRegistryRefresh.ts`). `/admin/pricing` (`pricingCoverage.ts`) lists
every unpriced holding across all users by cause; Settings → "Exchange coin
mappings" shows each user how their exchange tickers were matched.

**History.** Performance keys price history by `price_key` (`priceHistory.ts`
`getPriceHistoryMap`): old `price_history` rows under the pre-price_key key,
rows under the key itself, and `asset_price_daily` (the daily snapshot's close,
`recordDailyCloses`), all three in one request (`price_history_bundle`); each
wallet's value history likewise (`wallet_value_history`,
`getWalletValueHistories`). Backfill fetches CoinGecko coins only.

**Open item:** phase 3d drops the legacy stores (`prices`, `coin_market_data`,
`exchange_asset_registry`, `token_registry` price/stat columns) behind the gate
in BACKLOG.md. Nothing may read them.

### 4.3 A failed part of a sync keeps its previous rows

A sync replaces a wallet's auto rows atomically (the `sync_*_holdings` RPCs), so
a source that soft-fails must not return `[]` and erase its rows. Every soft
failure returns a `KeepScope` (`src/lib/carryForward.ts`: `chainScope`,
`protocolScope`) naming the rows it owns; they're re-saved from the last run and
the status says so. A new adapter or soft-failing source must declare one.
(DECISIONS: 2026-09-24)

**An error is never an empty result.** A source that fails throws (or
returns a failure); only an answer that really says "nothing here" is `[]`
(Etherscan's "No transactions found", Blockscout's 404 "Not found").
Transaction history follows the same rule: each chain tries its sources in
order (`transactionSources.ts` `txSourcesFor`: Alchemy, Etherscan,
Blockscout) and a chain none of them answers keeps its saved rows, named in
the status (`txSyncStatus`). (DECISIONS: 2026-09-26 Transaction history)

### 4.4 DeFi positions: native adapters first, Zerion fills the gaps

An EVM wallet's one Sync (`syncWalletHoldings`) fetches its balances, the native
protocol adapters (Hyperliquid, Lighter, INIT Capital, Axie, SuperVerse, Polymarket, …) and Zerion's
DeFi positions (`adapters/zerionDefi.ts`) in the same job — there is no separate
DeFi sync. **Zerion only covers protocols no native adapter owns:** each native
adapter exports the protocol names Zerion uses for it (`ZERION_PROTOCOL_NAMES`),
and `NATIVELY_COVERED_PROTOCOLS` skips them. **Building a native adapter for a
protocol means adding its Zerion names there in the same change**, so Zerion
never double-counts or overrides it. If Zerion fails, the last saved positions
stay and the sync status says so. Budget: one Zerion call per wallet sync
(free tier: 300/day, 1/second app-wide; its chain list is cached).
(DECISIONS: 2026-09-25 DeFi in the wallet sync)

The same rule holds on Solana: Jupiter's portfolio API
(`adapters/jupiterPositions.ts`) skips the products a dedicated adapter reads
(`SKIPPED_FETCHERS`: Jupiter Perps and Jupiter Prediction, read from their
dedicated APIs by `adapters/jupiterPerps.ts` and `adapters/jupiterPrediction.ts`).
An isolated-margin perps position is valued at what closing it returns
(collateral + PnL after fees), not its margin — see `jupiterPerps.ts`.
(DECISIONS: 2026-09-25 Jupiter Perps)

A Solana wallet's token names, prices and liquidity (what decides which
tokens are shown) come through `solana_token_info` (`solanaTokenCache.ts`
`mintsToLookUp`, `jupiter.ts` `tokenInfoCached`): only never-seen mints,
last time's shown ones (over $5 with $100k liquidity), dust worth ≥ $0.50
with a $10k market a day old and anything past its weekly age are looked up; Shield
verdicts too (`mintsToShieldCheck`, `unsellableCached`: a priced candidate
every read, a named unpriced one weekly). The weekly age is 7–14 days per
mint (`weeklyAgeFor`), so coins saved together don't all expire together. The cache is
read 1,000 mints per RPC call (Supabase returns at most 1,000 rows). A memecoin
wallet holding 8,417 mints made 158 Shield calls and 65 lookups every read
(~274 s); cached, 5 s. Never a valuation price (§4.2); the liquidity
floor and Shield check are unchanged; the cache failing means a full lookup.

Every on-chain Solana adapter lists accounts through `adapters/solanaRpc.ts`
`getProgramAccounts`: Helius's paged `getProgramAccountsV2`, falling back to
the one-shot method. Never call the RPC for it directly.

### 4.5 Two independent kinds of staleness

Price freshness is per coin (`asset_prices.updated_at`, shown by `pricesAsOf.ts`
and the price cell tooltips). Sync freshness is per wallet
(`wallets.last_refresh_at` / `last_refresh_status`). Don't conflate them.

### 4.6 Every table lives in the `cryptoport` schema

The Supabase clients are pinned to it; a table anywhere else is invisible to the
app. Per-user tables get `user_id uuid references auth.users(id) on delete
cascade default auth.uid()` plus RLS `create policy "<table>: owner only" …
using (user_id = auth.uid())` (as `wallets`, `tags`, `linked_wallets`,
`portfolio_snapshots`). Shared tables get `grant all … to service_role` and, if
read by pages, a signed-in select policy. (DECISIONS: 2026-09-24 SQL in public)

### 4.7 Which tokens an EVM sync reads

`docs/sync/PLAN.md` is the design. Per chain (`multicallEvm.ts`
`fetchChainHoldings`):
- **Discovery:** each chain's `discovery` source (`evmChains.ts`,
  `adapters/tokenDiscovery.ts`) lists the contracts the address holds —
  Alchemy's token API (20 chains) or a Blockscout explorer's token list (Mode,
  Metis, Aurora, Merlin) replace the registry scan; Etherscan's transfer
  history (Taiko, Mantle, opBNB, Fraxtal, Sonic, Sei) only adds to it, because
  its free key allows 3 calls/second app-wide (`adapters/etherscanFetch.ts`
  paces every Etherscan call, discovery and Transactions alike; a wallet that
  would wait over 5 s skips it for that sync). All-or-nothing: an error, or
  more than the page cap, falls back to reading every listed token
  (`token_registry`), as chains with no source do. A new source is checked
  live per chain before it's added.
- **What is read:** discovered ∪ the wallet's tokens from the last sync (∪ the
  whole registry on fallback) — `tokenDiscovery.ts` `candidateTokens`. Balances
  always come from our own `balanceOf` multicall, never the indexer's number. A
  listed contract for the chain's native coin (CELO's ERC-20) is skipped, since
  the native balance already counts it.
- **What becomes of each held token** (`classifyHeld`): counted; a receipt
  valued as its underlying (§4.2); dust (≤ `TOKEN_USD_FLOOR`); or
  unrecognized (unlisted, or listed with no price). Unrecognized tokens go to
  `wallet_discovered_tokens`, never into totals and never written to
  `token_registry`; a token unseen for 2 syncs of its chain is removed. The
  wallet page lists them ("N unrecognized tokens not included", a collapsed
  section; `unrecognizedTokensQuery.ts`), with likely spam behind a toggle
  (`tokenSpam.ts`: a real web domain, a handle or a claim in the symbol, the
  name of a listed coin on the same chain, or look-alike letters). Symbols
  render as plain text, never links. `/admin/pricing` summarizes them across
  users.
- Each sync logs per-chain source, fallback, pages, time and counts to
  `sync_runs`. Check it before changing discovery.
- A new chain gets a `discovery` source when one is checked live (Alchemy
  first, then Blockscout, then Etherscan); otherwise it stays on the registry
  scan (Manta, PulseChain, Fantom, Cronos, Kava, Chiliz, Polygon zkEVM, DBK as
  of 2026-09-25 — no working free source).
(DECISIONS: 2026-09-25 Wallet balance discovery)

## 5. External APIs — sparing, deliberate, measured

- **Ask the owner before any CoinGecko call you initiate yourself** (scripts,
  diagnostics, verification, backfills — even a handful), and check
  month-to-date usage on the CoinGecko dashboard before a bulk run (the `/key`
  endpoint is Pro-only). Prefer another source (DefiLlama, Hyperliquid, the
  chain itself) when it answers the question. Plan limits and the app's own
  limiter are in `coingeckoFetch.ts` (`CALLS_PER_MINUTE`, header comment); the
  backup key (`COINGECKO_API_KEY_BACKUP`) is a safety net, not budget. Bulk
  scripts refuse to run past a call cap without `--confirm`
  (`scripts/screener-backfill.ts`). The app's normal usage and crons aren't
  gated, but every new call path you add must justify its cost.
  (DECISIONS: 2026-09-22)
- **Supabase requests are a budget too, not just external APIs.** Every
  request the app makes to Supabase (each `.from()`/`.rpc()` page, each auth
  call) writes a ~3 KB log line, and the organization's free plan allows
  1 GB of logs a month for **all** its projects together (this project is
  shared with the csp-screener app; Trace Two is another). That is about
  11,000 log lines a day org-wide; keep cryptoport under ~5,000. Passing it
  restricts the project. Rules:
  - Sign-in is verified locally (`getClaims`, §3) — never a network auth
    call per request. Anything in `proxy.ts` runs on every request, link
    prefetches and API polls included: it must make no Supabase call.
  - Count the requests a change adds per page view, per sync, per poll and
    per cron run before building it. A full-table paged read on every page
    view, a query per row or per wallet in a loop, or a poll that runs while
    nothing is busy is a design smell — read once per request (`cache()`),
    batch (`.in()` / one upsert per 500 rows), or cache rarely-changing
    tables (`assetKeys.ts` mapping tables, 5 min, cleared on write;
    `asset_prices` once per request via `getAssetPriceRows`).
  - The dev server, diag scripts and verification runs hit the same
    production project and count against the same quota.
  - Measure after any change that adds a request path, and when in doubt:
    Logs → Logs Explorer (not the SQL Editor), time picker "Last 24 hours",
    `select source, count(*) as n from logs group by source order by n desc
    limit 50`, then per path: `select log_attributes['request.path'] as path,
    count(*) as n from logs where source = 'edge_logs' group by path order
    by n desc limit 30`. (DECISIONS: 2026-09-26 Supabase log ingestion)
- **Every service that could need an upgrade is on the API list**
  (`src/lib/apiRegistry.ts`, Owner's console → API list): its tier (free
  without sign-up / with sign-up / paid), plan, limits and what breaks first
  as users grow. A service that's free and scales (a chain's own public
  node, a user's own exchange key, a link) goes in `UNLISTED_HOSTS` with why.
  `apiRegistry.test.ts` fails on any https host in the code that's in
  neither — add the entry in the same change that adds the call, and keep
  plans and limits true when they change. (Owner decision 2026-09-28.)
  Every CoinGecko call is counted per day and feature (`apiUsage.ts`
  `countApiCall`, from `coingeckoFetch`'s `feature` option or its endpoint;
  one RPC per request, after the response) and shown on the API list — name
  the feature when adding a call.
- **Every diagnosis and proposal states its cost and what it saves**
  (owner, 2026-09-29): the time saved (measured, or labeled an estimate),
  and its effect on each limit — Supabase requests a day (§5 budget),
  Vercel (function invocations, active CPU and duration on Hobby — see the
  API list), external API calls and credits, and model tokens where an
  agent or LLM call is involved. Prefer the documented industry-standard
  approach that also lowers usage; say so when one can't. (DECISIONS:
  2026-09-29 Page latency)
- **Batch and dedupe by design:** one pricing pass per event, deduped across
  wallets and users (`ensureAssetPrices` reuses fresh prices); batched endpoints
  (`/coins/markets` by id, `per_page` = batch size); slow-changing data cached in
  the DB (below). Adding a per-holding or per-wallet call is a design smell.
- **Every external call goes through the shared plumbing:** `fetchWithRetry`
  (429/503 with backoff, honors `Retry-After`), `mapWithConcurrency` /
  `sequentialWithSpacing` (`adapters/http.ts`) — never an unbounded
  `Promise.all` over tickers/contracts; `coingeckoFetch.ts` (every CoinGecko
  call: rolling-window limiter, backup-key failover on quota errors);
  `jupiterFetch.ts` (process-wide pacer). Assume any new free API rate-limits
  bursts until proven otherwise.
- **Research before building an integration:** check for a standard, a
  maintained package, or a free API, and record its real rate limit and coverage
  in the commit or plan. Reuse over rebuild (EIP-6963 via `mipd`; a source's own
  24h-change field over computing deltas).
- **Verify live, don't trust docs or assumptions.** When data looks missing,
  reproduce against the real endpoint (under realistic load) before calling it a
  structural limitation. (DECISIONS: before 2026-09-22 "The API doesn't have
  this data")
- **Every request has a time limit:** `fetchWithRetry` gives up on an
  attempt after `REQUEST_TIMEOUT_MS` (20 s) and doesn't retry a timeout; EVM
  RPC calls (`evmTransport.ts`) time out at 10 s with one retry. A source
  that times out fails like any other (its rows carry forward, §4.3). A
  call that's legitimately long passes `timeoutMs` (CoinGecko's full coin
  list: 60 s). 2026-09-29: with no limits, one stalled node held a Wallet
  Watch read for minutes.
- **A list packed into one URL is split by length, not only by count**
  (`urlBatch.ts` `chunkByLength`): CoinGecko's CloudFront refuses a query
  over ~2,000 characters with a bare 403 "Request blocked" — 250 coin ids
  (~3,400) failed every price refresh on 2026-09-29, from everywhere.
- Every external `fetch()` passes `cache: "no-store"`. Live financial data is
  never cached without a staleness caption next to it.

### Caching

1. **Within a request:** wrap query functions several callers use in React's
   `cache()` (e.g. `getPriceMap`, `getAssetStatsMap`, `getActiveWalletsWithHoldings`).
2. **Slow-changing external data:** persist in the DB and refresh on a schedule
   or on demand — `token_registry`, `chain_icons`, `exchange_assets`,
   `coin_cache` logos. `ttlCache.ts` is an in-process cache for short-lived
   responses and carries `fetchedAtMs` so any shown value can be captioned.
3. **Expensive research artifacts** (an LLM explanation, a multi-API workup)
   are stored forever and recomputed only when a user asks: a compare-and-set
   claim plus the work inside `after()` (`claimTokenAnalysis`/`runTokenAnalysis`,
   `claimTrendExplanation`/`runTrendExplanation`), shown with
   `formatStaleness(computedAt)` and a Refresh button. Never a TTL that silently
   re-runs on a page load. (DECISIONS: before 2026-09-22 Research artifacts)
4. **Router Cache:** `next.config.ts` sets `experimental.staleTimes.dynamic` so a
   revisited page reuses its render. That is safe only because every real data
   change purges it: an action's own `revalidatePath`, or `JobPoller` →
   `notifyJobsComplete()` (`revalidatePath("/", "layout")`) when a background job
   finishes. If a Next upgrade narrows `revalidatePath`, re-check this.
   (DECISIONS: before 2026-09-22 Router Cache)

- **Safeguards, not caps** (owner 2026-10-02, after the bot incident): every
  feature stays open to every user; bot-like use locks that user out.
  `abuseGuard.ts` `guardUser` / `guardUse` count each costly feature's uses
  per user (per IP for a signed-out visitor) against thresholds no person
  reaches — lookups 30/min, Refresh activity 30/h, the day endpoint 1,200/h,
  trading record 30/h, backfill 10/h, coin refresh 300/h, Wallet search 60/h, Perp Scout scans 20/h and
  its price refreshes 300/h
  — and crossing one locks the user out of the costly features for 24 h
  (`app_settings` `user_lock:<key>`, honoured by every instance; read at most
  once a minute per user per instance) with a 🚨 Discord line. The owner is
  never locked. The public lookup also caches each address for 5 minutes.
  A new costly route adds a `guardUser` call and a threshold.

## 6. Background work and loading feedback

- **A Server Action doing more than a couple of seconds of work returns at once
  and does the work inside `after()`** (`next/server`). Next runs actions and
  navigations through one sequential queue per client, so an awaited slow
  action freezes every click app-wide. Pattern: `syncWalletHoldings`
  (`wallets/actions.ts`). A job of a few seconds can instead be a route
  handler the button awaits, then one `router.refresh()` — no polling
  (Refresh prices, `api/prices/refresh` → `priceRefreshJob.ts`: 9.9 s → the
  job's own ~3 s, 2026-09-29). `after()` shares the route's
  `maxDuration`, so pages whose actions start jobs export `maxDuration = 300`.
  A read the client calls often can be a route handler instead of a Server
  Action to stay out of that queue (`api/tv-symbol`). (DECISIONS: before
  2026-09-22 slow action)
- **Jobs claim their row with compare-and-set** (status not busy, or started
  before `JOB_STALE_MS`) and return a `JobStartResult`; status vocabulary and
  derivation live in `src/lib/jobStatus.ts` (`deriveJobStatus`). UI:
  `components/jobs/` — `useJob` + `JobButton` (locked for the real duration),
  `SlowJobHint`, one `JobPoller` loop over `/api/job-status`.
- **Live status checks are only for a job a user started and is waiting on**
  (owner rule, 2026-09-28). They exist so a click that takes 30 s–2 min
  visibly works; each check is several Supabase requests (§5). Background
  work nobody is watching — a cron — is never polled for, even with a page
  open: its claim uses `SCHEDULED_STATUS` (`jobStatus.ts`; `JobStatus.
  scheduled`), which `useJob` doesn't poll, and the page shows its result
  on the next load. Pick the interval for the job's length and importance:
  2.5 s (`useJob` default) for your own wallets' sync and prices, 10 s for
  Wallet Watch's minutes-long reads (`RefreshWatchButton`).
- **Completion reaches the browser through `JobPoller` → `notifyJobsComplete()`**,
  never through a `revalidatePath` inside `after()` (its response is already
  sent). One notify in flight at a time (it waits in the Server Action queue
  and re-renders the page), with `router.refresh()` if the action itself
  fails. A page's render time is part of every completion: keep data pages
  fast (no serial query loops). (DECISIONS: 2026-09-23)
- **Sync all** runs in the browser (`SyncQueue.tsx`): wallets sharing a
  rate-limited API form a lane (`syncLanes.ts`), lanes run in parallel, each lane
  runs up to `LANE_CONCURRENCY` at once; each wallet is its own request (its own
  time budget); per-wallet status is live and failures are summarized.
- **Every page render has a round-trip budget: at most `TARGET_HOPS` (2)
  serial Supabase round trips.** Every independent read starts in the
  page's one `Promise.all` (a read that waits on another says why); a shared
  table over 1,000 rows is read in one round trip (an RPC returning json —
  prices and coin names: `asset_market_rows`, `queries.ts` `getAssetPriceRows`),
  never paged with `.range()` in a render — `renderBudget.test.ts` fails on
  a new paging loop and its allowlist only shrinks. Each render logs one
  line (`renderMeter.ts`, via `meteredFetch` in both Supabase clients; the
  path and kind come from `proxy.ts`'s `x-cp-path`):
  `[render] /dashboard load req=13 hops=2 db=198ms slow=wallets:120ms` —
  `slow` is the longest request (body included), `cold` marks a new server
  instance's first render. Check it on Vercel before and after any change
  to a page or its queries.
  **A page showing only the user's own coins reads only their prices:**
  `scopePricesToUser()` at its top → `my_market_rows` (holdings, watchlist,
  perp marks; `true` adds the Wallet Watch coins they can see — one row per
  coin, priced or not; signed-in users may read `asset_prices`' price
  columns and `assets`). A lookup outside the scope is logged as
  `scope-miss=` on the `[render]` line (`scopedPrices.ts`) and shows "—",
  never a value; a page with any miss needs the wider scope. Pages showing
  anyone's coins, admin and crons stay unscoped (docs/perf/PRICES_READ.md).
  What a page sends the browser is a cost too:
  a long series goes packed — dates once, values as lists
  (`seriesPacking.ts`; Performance 1.24 MB → 173 KB), and a client table
  gets a row type with only the fields it shows, never whole holdings
  (`holdingRows.ts`: `HoldingRow`, `AssetRowGroup`; Assets 972 → 253 KB) —
  a field a table starts to read without adding it there is a type error.
  Anything independent of the page's first reads starts with them (chain
  icons: `getChainIconMap()` in the first `Promise.all`); a page that only
  needs the user's influencer names and addresses uses
  `getWatchFeedTargets`, never the overview (every snapshot and price).
  Diagnose a page locally with `RENDER_METER_VERBOSE=1` (each request's
  start and duration under its `[render]` line).
  Streaming doesn't shorten a `router.refresh()` (a transition shows no
  fallback); fewer round trips do. Functions run in **pdx1** (Vercel →
  Settings → Functions), next to the database in Oregon. As of 2026-09-29
  every page is over budget (5–11 hops); the fix is phased. (DECISIONS:
  2026-09-29 Page latency)
- **Every click is fast or says why it isn't.** Mutating forms use `SubmitButton`
  with a specific `pendingLabel` ("Refreshing prices…", not "Saving…"); slow work
  gets a caption saying why ("this pulls a live price for every holding").
- Every route that fetches on render is covered by a `loading.tsx`
  (`(app)/loading.tsx` for the group; add a route-specific one only for a
  tailored skeleton).
- **But `loading.tsx` only covers first entry into a route segment.** A same-route
  click that only changes a search param (tab, filter, re-search) shows nothing
  unless the param-dependent content sits in its own
  `<Suspense key={…params}>` — see `trend-finder/page.tsx`,
  `encyclopedia/page.tsx`, `signals/page.tsx`. (DECISIONS: before 2026-09-22
  searchParams)
  The same holds for a dynamic segment: going from `/wallet-watch/A` to
  `/wallet-watch/B` only changes `[id]`, so a route with an `[id]` page
  needs its own `loading.tsx` there (`wallet-watch/[id]/loading.tsx`).
  And a detail page reads only its own rows — never a list page's
  everything-query filtered afterwards (`watchQuery.ts` `readWatch(onlyId)`).
- **Relative times** ("x ago") use a request-anchored clock —
  `requestNowSec()` (`requestClock.ts`) on the server, `useNowSec(serverNowSec)`
  (`components/useServerNow.ts`) on the client — never `Date.now()` at render
  (a cached render can be re-shown much later).

## 7. Code and UI conventions

- **Modular by default.** Small focused files over shared abstractions built
  ahead of need. Pure logic (no DB, no network) goes in its own `src/lib/*.ts`
  with a sibling `.test.ts`; the Supabase layer (`queries.ts`, `*Query.ts`) and
  components stay separate. Relative imports in files `node --test` loads need
  explicit `.ts` extensions.
- **`import "server-only"` in every module with a heavy or sensitive dependency**
  (viem, siwe, @noble/*, service-role DB). Tests keep working because `npm test`
  uses the package's `react-server` condition — never drop the guard to fix a
  test. A heavy module must not also export small pure helpers other code needs
  (`walletDisplay.ts` pure vs `walletAuth.ts` heavy). (DECISIONS: before
  2026-09-22 server-only; heavy module)
- **Duplication threshold:** before copying real logic (more than a 3–5 line
  presentational helper), grep for existing copies. Two copies is the limit; a
  bug fix that has to land in two copies means extract a shared version now. A
  tiny helper may be duplicated across a server-only boundary instead of
  importing the heavy module.
- **No band-aids.** Fix the category, not the instance: a gap found in the
  owner's data is a sample of a class of inputs. Fix the rule or source so other
  users' tokens, exchanges and DeFi positions resolve on their own, and make the
  gap visible (`/admin/pricing`). A hand-added data row is a labeled stopgap
  ("Set by hand (stopgap)" in Settings), never the fix. (DECISIONS: 2026-09-25
  category)
- **Extend a feature before adding one.** Before building a new page, panel
  or table, check whether an existing one already shows that kind of data
  and could take the new part as a window, filter, tab or column (the
  activity table, a holdings table, a chart). A new surface needs a reason
  the existing one can't serve. When proposing a feature, say where it
  appears ("a 7/30-day tab on the Activity table", not "a Recent trades
  view") and which existing feature it extends. (DECISIONS: 2026-09-29
  Extend before adding)
- **Build with bot protection from the start** (owner 2026-10-02, after a
  bot wallet paused the site and emptied Helius in one night). Every
  feature that spends anything per use — a paid or rate-limited API, a
  webhook, a function run per event, a sizeable Supabase read — ships with
  its safeguard in the same change, not later:
  - **Never block normal use; lock out bot-like use.** Thresholds sit far
    above what a person does by clicking; crossing one locks that user (or
    IP) out of the costly features and says so on Discord (`abuseGuard.ts`
    `guardUser`, a threshold per feature). The owner is never locked.
  - **Anything a third party can trigger** (webhooks, public pages) is
    judged by volume over a day, not a burst, before it's switched on, and
    switched off automatically when it turns bot-like (`liveBudget.ts`,
    `liveBotGuard.ts`): count, confirm, disable, alert.
  - **Fail closed and quietly:** acknowledge what can't be processed (no
    retry storms), stop calling a failing dependency (`dbBreaker.ts`), cap
    pages and retries, and never let a removed or failed item keep costing
    (`releaseUnwatched`, the daily `sweepLive`).
  - State the worst case in the change's cost note (§5): what one user, one
    bot or one busy address could spend in an hour.
- **Reuse UI primitives** before building one-offs: `Panel`, `PageHeader`,
  `GuestBanner`, `SignInPrompt`, `AuthButtons`, `ui/table.ts` classes,
  `buttonClass`, `SubmitButton`. Small presentational duplication beats a shared
  component that needs prop-plumbing.
- **Guest state on a data page renders the real page shell:** one `GuestBanner`
  where `TotalValuePanel` would be, and every section's Panel with a muted "Log in
  and add a wallet to see your {noun} here." — no fake data. Public data (the
  Coin360 heatmap) renders for everyone. `SignInPrompt` is for pages with nothing
  to preview (`wallets/new`, `profile`).
- **Numbers** go through `src/lib/format.ts` (`formatUsd`, `formatPercent`,
  `formatQty`, `formatStaleness`…): `—` for missing; `text-positive` /
  `text-negative` / `text-warning` for gain, loss, warning; never a bare 0.
- **Tables are sortable by default:** `SortableHeader` / `SortIcon`
  (`components/ui/SortableHeader.tsx`) and `usePersistedState` keyed
  `cryptoport:<table>Sort`; a local `SortKey` union, a `sortValue(row, key)`
  switch, `toggleSort` flipping direction on repeat else `desc` (see
  `components/admin/AdminWalletsTable.tsx`). Columns with no scalar value skip it.
- **Mobile from the start:** secondary columns append `hideOnMobileClass` to the
  existing cell class; every table is wrapped in `overflow-x-auto`; the mobile
  nav drawer shares `navItems.tsx` with the sidebar.
- **Page widths are fluid up to a cap** (`AppShell.tsx`): table pages fill
  up to 1600px; a page marking itself `data-page-width="full"` (the
  Dashboard) has no cap and adds columns on wide screens (a named `3xl`
  breakpoint, 1920px, in `globals.css` — arbitrary `min-[…]` variants
  sort before `2xl` and lose); reading pages (Settings, Profile,
  Encyclopedia, new wallet) mark themselves `reading` in a route
  `layout.tsx` and keep 1152px. The Dashboard is a 12-column grid: a stat
  strip on top (`DashboardStats`); row 1 chart | movers (gainers and losers
  side by side when the card fits them, a container query); Wallet Watch
  full width, and from 3xl Wallet Watch 8 | heatmap 4 (12 without Wallet
  Watch) with open positions last; phone order set by `order-*`. Cards fill
  their row's height (`Panel` in a flex column; `ValueChart fill`, the
  heatmap iframe absolute) — no stretched card with an empty bottom. One
  header row per card: `Panel`'s `title` / `toolbar` (tabs, status) /
  `actions`, the toolbar on its own line on a phone; notes go in an
  `InfoTooltip`, not lines of text. Wallet Watch's day table is
  `useDayActivity` + `DayStatus` + `DayTable` (the Dashboard puts the status
  in its header and listens for live updates only on that tab;
  `DayActivity` composes the same parts on the Wallet Watch pages).
- **A section a reader may not need every time is collapsible**
  (`ui/CollapsiblePanel`: the title toggles it, remembered per browser,
  a summary beside the title when collapsed, actions still reachable).
  An influencer's page (Fable, 2026-09-30): a header card with the value
  left and every address right (chain · first/last 4 · copy, links),
  groups as chips under the title (`GroupChips`), rare switches in the
  card's footer; then Activity, Trading record, Holdings, Value over time
  (collapsed under 7 days of data). Confirmations happen in the page
  (`ConfirmActionButton`), never `window.confirm` — an app's built-in
  browser can block it and the button then does nothing. A name renames beside itself (`ui/InlineName`: a pencil
  turns it into a field in place — the influencer and wallet titles, the
  selected group and watchlist tab); an Edit button or dialog is for the
  other settings (the wallet's gear, an influencer's link and note).
- **Layout rules** (Fable, 2026-09-30, after the Dashboard, the influencer
  page and the wallet page each wasted the width) — check a page against
  them before pushing:
  - Explanation longer than one line goes in an `InfoTooltip` beside what
    it explains, never a `max-w-*` paragraph under it; a one-line caption
    is fine.
  - A detail page's first card is its header card: identity (name, chain ·
    mode · address, tags) left, the headline figure and its caption lines
    beside it, the job button in the card's top right with its own status,
    rare switches and delete in the `footer` (`InfluencerSections`, the
    wallet page with `TotalValueFigure`) — never a header row plus a
    separate figure card.
  - No `justify-between` row with one item each side and an empty middle:
    group related controls, or use a grid that fills the width.
  - Filters sit on one row with the card they filter (chips, Collapse/
    Expand, Hide checkboxes, the Add button); a filter with one option isn't
    rendered (one chain: no chain chips).
  - A variable number of options is `flex-wrap` chips sized to content
    (`ui/chip.ts` `chipClass`, `GroupChips`), figure inline — never
    `grid-cols-N` cards.
  - A job button owns its status: "Synced x ago · took Ns", errors and the
    slow hint sit under it (`SyncWalletButtons`, `SlowJobHint`).
  - A dollar figure derived from a total is masked with it (`useHideBalance`).
  - Text a sync writes into user data isn't page copy: the page recognizes
    it and shows it as a tooltip (`syncNotes.ts` `isSyncNote`).
  - Secondary sections are `CollapsiblePanel`s with a `summary`; the page's
    main table is never collapsed by default.
  - Width comes from layout (a grid, a stat strip), never from raising
    `AppShell`'s cap or widening prose.
  - Check every layout change at 390px and 1440px (and 1920px on
    `data-page-width="full"` pages): actions wrap under the title, never
    squeeze it.
- **The sidebar and the mobile drawer share one layout:** pinned header,
  links in their own scroll area (`min-h-0 flex-1 overflow-y-auto
  overscroll-contain`), Admin/Settings pinned at the bottom; heights in `dvh`
  (mobile toolbars), the drawer's footer padded for the iPhone home
  indicator. The page scrolls separately.

## 8. Schema changes

- There is no migration tool. Hand the owner runnable SQL **as a plain fenced
  code block in the chat** (not through a tool call); they run it in Supabase's
  SQL editor. Write it to a scratch file and pass
  `node scripts/check-sql-schema.mts` first. Then update `db/schema.sql` to match.
- **Order: SQL handed over → owner confirms it ran → preflight passes → push.**
  Push deploys, and a cron writing to a column that doesn't exist yet fails.
  Code that needs unrun DDL waits on a hold branch (§9). (DECISIONS: 2026-09-22)
- **Plan anything with real blast radius** (new table, new external service,
  new cron, schema change, irreversible drop) and get the owner's OK on scope
  before writing code. For multi-step work, write a plan doc like
  `docs/pricing/PLAN.md`: goal, decisions, phases, and a verification gate per
  phase.
- **Design a core subsystem before building it** (pricing, balance discovery,
  sync, identity — anything other features will stand on). The design doc must
  answer: how 2–3 leading products solve the same problem (Zerion, DeBank,
  Rabby, CoinGecko…) and what their unit of truth is; which existing service
  already provides it (an indexer API before our own scanning); how it holds
  up at 10× the users, chains and tokens, and for a user whose assets look
  nothing like the owner's; what fails and how that shows. Fable reviews the
  doc before code. Building the simplest thing that works for the data at hand
  and growing it caused the pricing, DeFi-sync and chain-scan rewrites of
  2026-09-25. (DECISIONS: 2026-09-25 design before building)

## 9. Process and git

- **Push directly to `main`**; no PRs.
- **Phased work: one commit per phase** (a revertable unit). Before committing,
  show `git status` and the exact file list; don't bundle unrelated changes
  (local-only edits, scratch scripts, other backlog items). Then stop for the
  owner's sign-off before the next phase.
- **Held work goes on a local `hold/<name>` branch, never `main`** (waiting on
  DDL, on a cron check, …). Release with `git merge --ff-only hold/<name>`, then
  push. **A general "go ahead and push" never releases a named hold**: name the
  held commits, restate what each waits for, and ask. (DECISIONS: 2026-09-23)
- **Never run a command that discards uncommitted changes** (`reset --hard`,
  `checkout -- <path>`, `restore`, `clean`, `stash drop`, an overwriting branch
  switch) without first `git status`, `git stash push -u -m "<why>"`,
  `git stash list`. To move an unpushed commit off `main`:
  `git branch hold/<name>` + `git reset --soft HEAD~1` + stash.
  (DECISIONS: 2026-09-24 reset --hard)
- **`next.config.ts` carries a local-only `allowedDevOrigins` change: never commit
  it, never discard it.** Stage files by name, not with `git add -A`.
- **Exercise CRUD through the UI** (add wallets via the form), not seed scripts.
- **Verify against real data before calling anything done**, especially data
  correctness: live calls, real DB rows, before/after totals — not just passing
  type checks. A store's own read-back is not verification; spot-check against a
  different source. Report outcomes faithfully, including what wasn't verified.
- **Keep this file true.** When a rule's mechanism changes or is deleted, update
  or remove the rule in the same commit; record why in `docs/DECISIONS.md`.
