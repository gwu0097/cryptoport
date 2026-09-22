# Backlog

Committed copy of items tracked in this session's memory (`~/.claude/projects/<project>/memory/`). Memory stays the detailed, durable version — this file is a scannable index with enough context to act on each item without needing the chat history. Each entry names where it was raised and its current status.

---

## Screener project

### Supabase storage overage — reclaimed; structural fix committed, deploy + step B pending
**Raised**: Phase 1 sign-off, 2026-09-22. **Diagnosed and reclaimed** the same day.

**Diagnosis (measured, not estimated)**: db_total 1,701 MB; `screener_asset_snapshots` was 1,614 MB of it (95%) — ~873 MB of live backfilled rows (1,611 B/row on disk, **92% of it the per-row `provenance` JSONB**) plus ~640 MB of unshrunk pages left by the ~383K deleted duplicates (autovacuum had already run — 49K dead tuples left, plain VACUUM had nothing to give) plus 103 MB of indexes. csp-screener and every other table combined: ~87 MB. The backfilled rows were also *wrong* for grouped assets (fetched one child slug instead of summing all — Hyperliquid revenue null, Uniswap fees 3.5x low).

**Reclaimed**: TRUNCATE + re-insert of the 1,106 live rows (not VACUUM FULL — it would have left ~1.0 GB, still 2x quota). db_total 1,701 → 87 MB.

**Structural fix (committed, not yet deployed)**: provenance is one manifest per run + a per-row override only on deviation; `contributing_slugs` stored once; the unmatched log is change-only (it was 7,307 rows/run ≈ 490 MB/yr — the biggest daily writer); backfill sums every child slug through the same function as the live job, writes its own run row, and is capped at 365 days. Remaining sequence: run step A2 SQL → deploy → step B SQL (drops the legacy column/table, with guards) → 20-asset validation backfill, measuring real bytes/row.

**Retention (decided)**: a monthly local job (`scripts/screener-archive.ts --delete`, launchd plist in `scripts/launchd/`) exports every snapshot row older than 400 days to Parquet under `~/cryptoport-archive/screener`, verifies it row-for-row (count + content SHA-256), then deletes those rows. Monthly from the start, not on a quota trigger, so the path is exercised early (backfilled rows cross 400 days ~35 days after a backfill). Export + verify tested on 424 real rows; `--delete` not yet exercised. **The archive dir is the only copy of any live row it removes — it must be on a backed-up disk.** Thresholds (per-row cost, steady-state size) get locked after the validation backfill measures real bytes/row.

### Regime: stablecoin 30-day change → our own stored history — due ~2026-10-22
**Raised**: Phase 2a sign-off, 2026-09-22. **Status**: scheduled, not started.

The regime's stablecoin 30-day change currently comes from DefiLlama's `/stablecoincharts/all` (last complete day vs exactly 30 days earlier; see SPEC, "Stablecoin 30-day change"). Two DefiLlama endpoints disagreed across BTC_LED's ±1% band, so the long-term fix is to not depend on either API's history. Compute the change from `screener_regime_snapshots.stablecoin_supply_usd` (stored daily since 2026-09-22) once a row exists ~30 days back (±3-day tolerance), with the endpoint value as the fallback. Keep storing the `_prevmonth` comparison column until the switch is verified, then decide whether to drop it.

### Storage watch-line automation — open
**Raised**: storage-fix sign-off, 2026-09-22. **Status**: not started.

Decided thresholds: archive snapshots after 400 days, backfill at most 365 days into Supabase, **watch line 350 MB db_total (70% of the 0.5 GB tier)** with ~200 days as the fallback retention if it's crossed (longest lookback is 180 days). Projected steady state ≈ 205 MB (41%). Today the watch line is a manual check (`select pg_size_pretty(pg_database_size(current_database()))` in the SQL editor) because PostgREST can't read database size. Fix: a `security definer` SQL function (e.g. `cryptoport.screener_db_size_bytes()`, service_role-only) called by the daily snapshot job, recording db size into `screener_runs.notes` and flagging when it crosses 350 MB — so the trend is visible in the same place as the gap detector. Needs a schema change (plan + confirm SQL first).

### DefiLlama `gecko_id` staleness — small, fixable, not urgent
**Raised**: Phase 1 sign-off, item D/1 investigation (10-sample audit of unmatched protocols).
**Status**: not started.

Of 149 protocols that resolved a `gecko_id` but got no CoinGecko market row, a 10-sample audit found 9/10 genuinely delisted (no CoinGecko presence under any name), but 1/10 (`idle`) was a real, fixable mismatch — DefiLlama's own `gecko_id` field is stale (`"idle"`), CoinGecko's actual current id for that same project is `idle-protocol`. Fix: a fallback `/search`-based resolution for unmatched ids, reusing `pickBestMatch`/`searchCoins` (already built, used elsewhere in this app for the same disambiguation problem). Low priority — affects a small minority of the 149.

### Historical market cap — confirmed structurally absent, not a research gap
**Raised**: Phase 1 sign-off, item 3.
**Status**: resolved as "not available," recorded for Phase 4 to design around (`PHASE_1.md`).

DefiLlama's coins/prices API has no historical-mcap endpoint on the free tier — confirmed both by live endpoint testing (`/mcaps`, `/mcap`, `/mcaps/historical` all 404) and DefiLlama's own official API docs. Multi-year (beyond ~365d) backtests can test momentum only; `ps_fd`/`pf_fd`/`buyback_yield`/size controls are capped at CoinGecko's ~365-day window. Not an open research item — a permanent constraint Phase 4 must label per-window, not re-investigate.

---

## General cryptoport features

### Trend Finder — peers weren't anchored to what the token does — FIXED 2026-09-22
**Raised**: general use, 2026-09-22 (ZRO/LayerZero example: MORPHO/AERO/UNI named as "peers" because all were Circle Arc launch partners — "like saying a project launched on Solana must be the same as another app launched on Solana"). **Fixed** in two steps: (1) peer reasons must be relational ("Same driver as <seed> (<catalyst>): <exposure>"); (2) peers are anchored on the seed's own CoinGecko functional categories (`categoryFilter.ts` drops chain-ecosystem/investor/index/listing tags; `coin_categories` 7-day cache), which are passed into the Perplexity search and enforced in code — an AI-named token only counts as a peer if it's a member of one of those categories; the rest show as "same news, different category". Live-verified on ZRO: anchor "Cross-chain Communication", AI peers W/LINK/AXL/STG. Stored explanations are reused until refreshed, so tokens scanned earlier keep old-style reasons until Refresh — but the code-side category gate applies to them immediately.

### SMC signal overlay — spec provided, not built
**Raised**: user-provided spec, `external/smc_signal_overlay_spec.md`, added 2026-09-22.
**Status**: not started, one real tension flagged before building. Full detail: `project_smc_signal_overlay_backlog.md`.

A standalone, read-only RMA(8)/SMMA(8) crossover chart overlay page (token + timeframe selector, no backtesting/alerting/trading, must show a disclaimer about its documented negative edge on BTC). Read the actual spec file when this gets picked up — it has exact formulas that shouldn't be reconstructed from memory. Flagged tension: the spec's own "100+ blocks of history" target isn't reachable for the `1W` timeframe using this app's existing CoinGecko-based candle source (365-day cap ≈ only ~17 weekly-aggregate blocks) — needs a decision (accept shorter history, or source deeper candle data) before implementation, not a silent workaround.

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
