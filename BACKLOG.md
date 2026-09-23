# Backlog

Committed copy of items tracked in this session's memory (`~/.claude/projects/<project>/memory/`). Memory stays the detailed, durable version — this file is a scannable index with enough context to act on each item without needing the chat history. Each entry names where it was raised and its current status.

---

## Screener project

### Supabase storage overage — RESOLVED 2026-09-22 (only the launchd install remains, on the user's side)
**Raised**: Phase 1 sign-off, 2026-09-22. **Diagnosed and reclaimed** the same day.

**Diagnosis (measured, not estimated)**: db_total 1,701 MB; `screener_asset_snapshots` was 1,614 MB of it (95%) — ~873 MB of live backfilled rows (1,611 B/row on disk, **92% of it the per-row `provenance` JSONB**) plus ~640 MB of unshrunk pages left by the ~383K deleted duplicates (autovacuum had already run — 49K dead tuples left, plain VACUUM had nothing to give) plus 103 MB of indexes. csp-screener and every other table combined: ~87 MB. The backfilled rows were also *wrong* for grouped assets (fetched one child slug instead of summing all — Hyperliquid revenue null, Uniswap fees 3.5x low).

**Reclaimed**: TRUNCATE + re-insert of the 1,106 live rows (not VACUUM FULL — it would have left ~1.0 GB, still 2x quota). db_total 1,701 → 87 MB.

**Structural fix (deployed; step B run)**: provenance is one manifest per run + a per-row override only on deviation; `contributing_slugs` stored once; the unmatched log is change-only (it was 7,307 rows/run ≈ 490 MB/yr — the biggest daily writer); backfill sums every child slug through the same function as the live job, writes its own run row, and is capped at 365 days. Full backfill done since (236,007 rows, all 682 assets; db_total 180 MB, 36% of quota).

**Retention (decided)**: a monthly local job (`scripts/screener-archive.ts --delete`, launchd plist in `scripts/launchd/`) exports every snapshot row older than 400 days to Parquet under `~/cryptoport-archive/screener`, verifies it row-for-row (count + content SHA-256), then deletes those rows. Monthly from the start, not on a quota trigger, so the path is exercised early (backfilled rows cross 400 days ~35 days after a backfill). Export + verify tested on 424 real rows; `--delete` not yet exercised. **The archive dir is the only copy of any live row it removes — it must be on a backed-up disk.** Thresholds (per-row cost, steady-state size) get locked after the validation backfill measures real bytes/row.

### Regime: stablecoin 30-day change → our own stored history — due ~2026-10-22
**Raised**: Phase 2a sign-off, 2026-09-22. **Status**: scheduled, not started.

The regime's stablecoin 30-day change currently comes from DefiLlama's `/stablecoincharts/all` (last complete day vs exactly 30 days earlier; see SPEC, "Stablecoin 30-day change"). Two DefiLlama endpoints disagreed across BTC_LED's ±1% band, so the long-term fix is to not depend on either API's history. Compute the change from `screener_regime_snapshots.stablecoin_supply_usd` (stored daily since 2026-09-22) once a row exists ~30 days back (±3-day tolerance), with the endpoint value as the fallback. Keep storing the `_prevmonth` comparison column until the switch is verified, then decide whether to drop it.

### Storage watch-line automation — open
**Raised**: storage-fix sign-off, 2026-09-22. **Status**: not started.

Decided thresholds: archive snapshots after 400 days, backfill at most 365 days into Supabase, **watch line 350 MB db_total (70% of the 0.5 GB tier)** with ~200 days as the fallback retention if it's crossed (longest lookback is 180 days). Projected steady state ≈ 205 MB (41%). Today the watch line is a manual check (`select pg_size_pretty(pg_database_size(current_database()))` in the SQL editor) because PostgREST can't read database size. Fix: a `security definer` SQL function (e.g. `cryptoport.screener_db_size_bytes()`, service_role-only) called by the daily snapshot job, recording db size into `screener_runs.notes` and flagging when it crosses 350 MB — so the trend is visible in the same place as the gap detector. Needs a schema change (plan + confirm SQL first).

### Duplicate live runs per day — pick one run per UTC day explicitly (Phase 4, 3b)
**Raised**: cron-proof review, 2026-09-23. **Status**: rule decided and implemented for 3b (`runSelection.ts`, SPEC "One run per UTC day"); Phase 4 must use the same helper.

Vercel cron delivery is best-effort: a run can be delivered twice, and manual runs also add same-day live runs (2026-09-22 had five). The live unique index is per run, not per day, by design. Two consumers must choose **one run per UTC day explicitly** rather than assume only one exists: **Phase 4's backtest** (otherwise a duplicated day is weighted twice) and **3b's "latest run" view** (latest `status = 'ok'` live run that has scores). History reads and funding history already dedupe per UTC day. **Accepted as-is:** if two deliveries overlap in time on a day with newly unmatched items, the second run's unmatched insert hits the open-interval unique index and that run is marked `error` after its snapshot rows are written (one spurious error run, no data loss, its derivations skipped). Details: SPEC, Cron section.

### CoinGecko: one key deep until the monthly reset (2026-10-01)
**Raised**: Phase 3a live run, 2026-09-23. **Status**: the failure mode is FIXED (2026-09-23): a cap now writes a **degraded** day instead of losing it (SPEC, "Degraded runs"). Still open: the backup key's remaining headroom, which only the CoinGecko dashboard shows (its sign-in page runs a Cloudflare human check, so it has to be read by hand). The primary Demo key is at its 10,000 calls/month cap (error 10006; hit 2026-09-22 by the full backfill). The whole app now runs on `COINGECKO_API_KEY_BACKUP`, with nothing behind it.

- **Reset**: CoinGecko replenishes call credits on the **1st of each month**, whatever the billing cycle ([CoinGecko support](https://support.coingecko.com/hc/en-us/articles/16760509234713-When-does-my-request-volume-monthly-API-credit-reset)). The primary returns on **2026-10-01**. The time of day and timezone aren't documented. `coingeckoFetch.ts` re-tries the primary on each cold start, so it resumes on its own.
- **Backup's month-to-date usage is unknown from here.** The `/key` usage endpoint is Pro-only (error 10005), so the CoinGecko developer dashboard is the only place to read it.
- **The screener's own draw is small**: about 5 calls per cron run (`/coins/markets` for ~832 ids in 4 batches of 250, plus `/global`), plus one rejected call on the capped primary per cold start. That's roughly 50 calls until the reset. **The risk is the rest of the app** (Dashboard, price refresh, Trend Finder, Encyclopedia) sharing the same backup key.
- **(Before the fix)** If the backup capped too, the daily run failed outright instead of degrading. In `snapshot.ts`, `fetchMarketsByIds` runs before any snapshot row is written. Its throw marks the run `error` with **zero rows**, the route returns 500, and no derivations run. That UTC day's point-in-time readings are lost for good: market cap, supply and volume come only from CoinGecko, and fees/revenue for that day would have to be backfilled. The regime's `/global` call would also fail (dominance null, handled). Every CoinGecko-backed feature in the app goes down at the same moment.
- **Options considered:**
  (a) **Built: degrade instead of fail.** write DefiLlama's fields (fees/revenue/TVL, price from `coins.llama.fi`) with market cap/supply/volume null. Every asset then fails the `core_data` gate and nothing is rated that day, but the fee/revenue series stays continuous.
  (b) A keyless third tier (CoinGecko's public API): free, but rate-limited per IP, and unreliable from Vercel's shared serverless IPs.
  (c) Don't run large CoinGecko jobs until after 10-01 (see the backfill budget rule in SPEC).

### Production `dilution_rate_implied` mixes moments for backfilled lookbacks — display only
**Raised**: Phase 4a, 2026-09-23. **Status**: open, low priority (display only; never a tier input). A backfilled row's market cap is CoinGecko's 00:00 point but its DefiLlama price is from the backfill run's ~21:31 grid, so market cap ÷ price (implied supply) carries ~0.65% of daily noise that doesn't exist. `dilution_rate_implied` annualizes a 90-day ratio, so the noise is multiplied. The backtest avoids it (`price_at_mcap_moment` from the deep store's 00:00 prices). The production fix would pass a same-moment price for backfilled lookback readings, e.g. from the deep store or a stored 00:00 price. Revisit when implied dilution is used for anything but display, or retire the metric once measured dilution exists (~2026-12-21).

### DefiLlama `gecko_id` staleness — small, fixable, not urgent
**Raised**: Phase 1 sign-off, item D/1 investigation (10-sample audit of unmatched protocols).
**Status**: not started.

Of 149 protocols that resolved a `gecko_id` but got no CoinGecko market row, a 10-sample audit found 9/10 genuinely delisted (no CoinGecko presence under any name), but 1/10 (`idle`) was a real, fixable mismatch — DefiLlama's own `gecko_id` field is stale (`"idle"`), CoinGecko's actual current id for that same project is `idle-protocol`. Fix: a fallback `/search`-based resolution for unmatched ids, reusing `pickBestMatch`/`searchCoins` (already built, used elsewhere in this app for the same disambiguation problem). Low priority — affects a small minority of the 149.

### Historical market cap — confirmed structurally absent, not a research gap
**Raised**: Phase 1 sign-off, item 3.
**Status**: resolved as "not available," recorded for Phase 4 to design around (`PHASE_1.md`).

DefiLlama's coins/prices API has no historical-mcap endpoint on the free tier — confirmed both by live endpoint testing (`/mcaps`, `/mcap`, `/mcaps/historical` all 404) and DefiLlama's own official API docs. Multi-year (beyond ~365d) backtests can test momentum only; `ps_fd`/`pf_fd`/`buyback_yield`/size controls are capped at CoinGecko's ~365-day window. Not an open research item — a permanent constraint Phase 4 must label per-window, not re-investigate.

---

### Run the pullback indicator backtest per `docs/signals/PREREG_PULLBACK_INDICATORS.md`
**Raised**: 2026-09-23. **Status**: deferred. The Signals page shipped the four indicators (RSI(2), Bollinger, MA pullback, Donchian) plus SMC first, as a discretionary visual aid; every banner says "Not backtested — visual reference only".

- **Pre-registered and ready:** rules, cost model (13 bps + actual funding; 30 bps stress; cost-sensitive flag), random-entry control, held-back third, **pooled** verdict per indicator × timeframe (15 tests), 1H labeled low-power, and Amendments 1–2. The code exists: `src/lib/signals/harness.ts`, `rules.ts`, `ta.ts`, and `scripts/signals-fetch-data.ts` + `signals-backtest.ts` (it refuses uncommitted code). Zero CoinGecko calls.
- **Idea to decide before running: a fixed ~15-token sample** instead of all 37 watchlist perps + BTC. The verdict is **pooled** (Amendment 1), so it's a property of the rule on a representative set, not of each token. Tokens added to the watchlist later inherit it instead of needing their own test, and the fetch shrinks a lot. Funding history is the slow part (hourly, 500 rows per call, ~26 calls/min; about 58 calls for a 3-year-old perp). The full universe was estimated at ~1.5 hours. The sample must be **fixed in a dated amendment before the run** and chosen on criteria, not results (e.g. a mix of majors, DeFi and newer perps with enough 4H history).
- **Already cached (kept):** full candles + funding for **kPEPE, PONS, ZEC, VVV, PUMP, TAO, UNI**, and candles only for **JTO**, in `~/cryptoport-archive/signals/data/`. The fetch script skips existing files.
- **What a backtest would and wouldn't measure:** every pullback rule's **SMA(200) filter** (RSI(2), Bollinger, MA pullback) already restricts entries to uptrends. So a backtest measures these setups **in the conditions they're designed for**, not in bear markets; a flat or negative result in a bear-heavy window would say little. Donchian (no trend filter) is the trend-following control.

## General cryptoport features

### Trend Finder — peers weren't anchored to what the token does — FIXED 2026-09-22
**Raised**: general use, 2026-09-22 (ZRO/LayerZero example: MORPHO/AERO/UNI named as "peers" because all were Circle Arc launch partners — "like saying a project launched on Solana must be the same as another app launched on Solana"). **Fixed** in two steps: (1) peer reasons must be relational ("Same driver as <seed> (<catalyst>): <exposure>"); (2) peers are anchored on the seed's own CoinGecko functional categories (`categoryFilter.ts` drops chain-ecosystem/investor/index/listing tags; `coin_categories` 7-day cache), which are passed into the Perplexity search and enforced in code — an AI-named token only counts as a peer if it's a member of one of those categories; the rest show as "same news, different category". Live-verified on ZRO: anchor "Cross-chain Communication", AI peers W/LINK/AXL/STG. Stored explanations are reused until refreshed, so tokens scanned earlier keep old-style reasons until Refresh — but the code-side category gate applies to them immediately.

### SMC signal engine + chart (+ auto-trading last) — scoped 2026-09-22, not started
**Raised**: user-provided spec `external/smc_signal_overlay_spec.md` + the source indicator `smc_bot_replica_v4_2.pine` (Pine v6). **Status**: scoped; **Phase 1 not started**; trading explicitly deferred to last. Full detail: `project_smc_signal_overlay_backlog.md`.

Decisions (2026-09-22) — these supersede the spec where they differ:
- **Goal changed from the spec**: the end state is automated trading on the buy signal (the spec said no order placement). Built **last**, after read-only phases, as its own planned project (new tables, scheduler, real-money writes → plan + SQL sign-off first).
- **Venue: Hyperliquid.** Signals are computed on **Hyperliquid's own candles** (same venue as execution) — `candleSnapshot` on `api.hyperliquid.xyz/info`, free, no key. Live-verified: 1h depth 5,000 candles (~208 days, the API cap), 4h/1d back to listing; 178 active perps; hourly candles UTC-aligned; the last candle returned is still forming (completeness guard required). Tokens not on Hyperliquid get no signal.
- **Timeframes: 1H, 4H, 1D** (blocks 3H / 12H / 3D). **1W dropped** — which removes the history-depth problem that was the original blocker (RMA(8) needs ~50 blocks to converge; all three fit easily).
- **Long only.** Future order shape: a long entry with a limit order + a stop order, and/or the indicator's SELL as the exit. Note for when it's built: a resting limit fills when price *touches* a level, while the signal requires a block to *close* past it — the order logic is its own strategy and needs its own backtest (the indicator itself has a documented negative edge on BTC, PF 0.88).
- **Signal logic:** a port of v4.2's ribbon + crossover with **Delay = 1** (the non-repainting mode; v4.2's own default of 0 repaints and can't be traded). The ATR trail is a placeholder in v4.2 and is not ported.
- **Chart:** TradingView's open-source Lightweight Charts in cryptoport (the free TradingView embed can't show a private Pine script) — candles, the Close/Open ribbon ("the baseline"), Buy/Sell markers, and the next flip's trigger price: a bullish flip ⇔ the forming block closes above `open + 7 × (OpenSeries − CloseSeries)` of the last completed values.

Phases: (1) signal engine + chart + watchlist state, read-only, validated against the user's TradingView chart; (2) paper trading; (3) live execution on Hyperliquid via an API (agent) wallet — trade-only, no withdrawal — with per-token size caps, a total-exposure cap, a daily loss stop, a kill switch, one-order-per-signal idempotency, an audit log and notifications.

### Transactions — chain coverage gaps
**Raised**: general use, 2026-09-15 through 2026-09-16.
**Status**: partially resolved (ADA, INJ built); ATOM and NEAR still open; 10 non-EVM chains never researched. Full detail: `project_transactions_chain_backlog.md`.

- **ATOM**: real gap, not unresearched — the generic Cosmos SDK LCD tx-search fails (live-verified zero results across 2 real wallets, 3 independent free LCD providers). No free Cosmos Hub indexer found yet (Cosmostation unreachable, Numia needs a paid key, Mintscan 404s). Needs either an undiscovered free indexer or accepting a paid key.
- **NEAR**: free/keyless API exists (NearBlocks) but tightly rate-limited without a signup key; also receipt-based (needs hash-grouping) and native+NEP-141 transfers need merging from two endpoints.
- **EVM gaps with no free source found**: Avalanche (explorer blocks server-side requests), BSC (no free Blockscout, Etherscan gates it), Manta (no reachable Blockscout instance).
- **Never researched**: SUI, FIL, BCH, DOT, TAO, NEO, XRP, TON, APT, ICP.

### Trending tab (top-volume tokens per chain)
**Raised**: general use, 2026-09-17.
**Status**: researched across two sessions, not built. Full detail: `project_trending_feature_backlog.md`.

General feature is feasible via GeckoTerminal (free, keyless, covers 31/32 configured EVM chains + Solana) — real constraints to design around: no free 7d volume anywhere, data is per-pool not per-token, tight rate limits need a DB-cached refresh pattern (not live-per-view). **Robinhood Chain specifically has no working free source** — 5 options checked and ruled out (GeckoTerminal doesn't index it, CoinGecko's curated categories are narrower than comprehensive, Blockscout re-serves CoinGecko's global (not chain-native) data, DefiLlama is protocol-level not token-level, DexScreener has the right data but no public list-by-chain API endpoint and TLS-reachability issues from this environment).
