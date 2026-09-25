# One price per asset — plan

Status: phases 1–3c SHIPPED 2026-09-25 (19aeb56 … 948f282); 3d (drop the
legacy tables) pending its gate in BACKLOG.md. The "what exists today"
section below describes the system *before* this plan, kept as the record
of why. The current design is summarized in CLAUDE.md ("Pricing").

## Goal

Every holding is valued from **one deduplicated price per asset**, held in
**one table**, refreshed with **as few API calls as possible**. The same asset
shows the same price, 24h change and market cap on every page (Assets,
Dashboard movers, Watchlist, Portfolio, Analytics, wallet pages). A missing
price stays unknown ("—"), never a guess. The price table is ground truth:
it records only what a source reported.

## Why (what exists today)

Prices live in five places, written by different code paths:

| Store | Keyed by | Written by | Read by |
|---|---|---|---|
| `prices` | ticker | Refresh prices lanes, post-sync ticker pricing | valuation of holdings without `usd_override` |
| `holdings.usd_override` | holding | ~45 sync adapters, EVM + Cosmos refresh lanes | valuation (wins over everything) |
| `token_registry` stats + `price_usd` | chain + contract | EVM sync, EVM refresh lane | asset rows' 1h/24h/7d/30d, sync price cache |
| `coin_market_data` | CoinGecko id | watchlist refresh | Watchlist, watchlist movers |
| `coin_cache.usd` | CoinGecko id | sync (native + Cosmos) | sync |

And the identity of "which coin is this" lives in six: `holdings.coingecko_id`,
`token_registry.coingecko_id`, `exchange_asset_registry`,
`watchlist_items.coingecko_id`, `liquid_staking_tokens`, `coin_cache`.

Seen on 2026-09-25: MORPHO at +13.89% / $2.42 (holdings) and −5.6% / $2.75
(watchlist) at once; a Coinbase MORPHO unpriced for a day; ~300 CoinGecko
calls per Sync all; batched `/coins/markets` calls silently returning only 100
of up to 250 coins (no `per_page` — fixed in 9619f88).

## Industry practice (research, 2026-09-25)

- **A canonical asset id above many chain contracts, never the ticker.**
  Zerion: one "fungible" per asset with per-chain implementations and one
  price. Rotki (open source): CAIP-19 id per contract, mapped to a CoinGecko id
  for pricing; tickers rejected (three different tokens named KEY).
  CoinTracker moved from symbol to contract matching after wrong prices.
- **CoinGecko's coin id is the dedupe unit, and it does not merge bridged
  copies.** Native deployments share one id (Circle USDC on Ethereum/Base/
  Arbitrum/… = `usd-coin`); bridged copies have their own
  (`usd-coin-ethereum-bridged`), because a bridge failure can crash the copy
  while the coin is fine (Multichain USDC on Fantom ~$0.50 in 2023). WETH,
  stETH, wstETH, jitoSOL are their own coins.
- **Every price has a source and its own timestamp**; spam is judged per
  token, not per ticker; batch by id (`/coins/markets`: 250 ids per call with
  price, 1h/24h/7d/30d change, market cap).

## Decisions

- **One truth per CoinGecko coin id.** Native deployments of a coin dedupe to
  one price. WETH, bridged copies and liquid staking tokens keep their own
  price as the source reports it — no redirects, no "priced as its base
  coin"; a variant drifting from its base coin (a depeg) stays visible.
  Combining with the base coin is display-only (like the Assets "Combine liquid
  staking tokens" toggle). *(owner)*
- **No stablecoin pinning.** Today Hyperliquid, Polymarket and Parcl pin
  USDC-likes at $1 (hyperliquid.ts:152, polymarket.ts:120,
  parclPositions.ts:92). USDC traded ~$0.87 in March 2023; a pin is a guess.
  They get their real CoinGecko id instead. *(review)*
- **Refresh is ad hoc** — the Refresh prices button and after a sync. No
  periodic refresh. **The daily snapshot refreshes prices first** (when older
  than ~6h, ~2 calls/day) so Analytics history never records stale values. *(owner)*

## Design

### 1. Identity: `assets` + `asset_contracts`, and `holdings.price_key`

Identity is collapsed to one place:

```
assets (
  price_key    text primary key,  -- CoinGecko id, or a namespaced fallback
  symbol, name, image_url text,
  kind         text,              -- 'coin' | 'bridged' | 'wrapped' | 'lst' | 'stable' ...
  base_key     text               -- display grouping only (LST, bridged, wrapped -> base)
)
asset_contracts (
  chain, contract text,           -- contract = address / mint / Sui type / Cosmos denom / 'native'
  price_key    text,
  mapping_source text,            -- 'registry' | 'native' | 'exchange' | 'manual' | 'jupiter' | 'hyperliquid'
  updated_at   timestamptz,
  primary key (chain, contract)
)
exchange_assets (exchange, ticker -> price_key)   -- per exchange, not Coinbase's catalog for all
```

- `holdings.price_key` is set at sync (or when a manual holding is added) and
  **replaces** `holdings.coingecko_id`. The registry, exchange registry,
  liquid staking tokens and watchlist ids all resolve into `assets`.
  `token_registry` stays for decimals only.
- **Key rule:** a CoinGecko id whenever one exists (HYPE is `hyperliquid`, not
  `hl:HYPE`). Namespaced keys only for the long tail CoinGecko doesn't list:
  `jup:<mint>` (Solana, per-mint price), `hl:<token>` (Hyperliquid spot),
  `coinbase:<ticker>` (Coinbase-held, no id). **One source per key**, so two
  sources can never fight over the same price.
- **Unmapped = unpriced.** A token with no mapping has no key and no price —
  never a ticker match. This closes the Solana ticker-collision gap
  (valuation.ts "KNOWN GAP").
- **Contested contracts** (two CoinGecko coins claiming one chain+contract)
  are unresolved ("—"); the registry refresh flags them instead of keeping the
  last one seen (today's `dedupeTokenRegistryRows`).
- **Id churn:** when a registry refresh remaps a contract, a reconcile step
  updates the affected holdings' `price_key`.
- **Exchange mappings** are keyed (exchange, ticker) — Kraken/Gemini/MEXC no
  longer borrow Coinbase's catalog — and shown in the UI so a wrong match is
  visible and correctable (today's matcher is a best-guess heuristic).
- **New registry work:** Sui has no contract→id map yet (coingeckoIds.ts has
  no `sui` platform).

| Holding | `price_key` |
|---|---|
| EVM token | `asset_contracts` (chain, contract) |
| Native coin on any chain | `asset_contracts` (chain, 'native') |
| Solana SPL | CoinGecko id, else `jup:<mint>` |
| Sui coin | CoinGecko id (new map), else unpriced |
| Cosmos token | CoinGecko id from the chain/Keplr registry |
| Exchange balance | `exchange_assets` (exchange, ticker), else `coinbase:<ticker>` for Coinbase |
| Hyperliquid spot | CoinGecko id if listed, else `hl:<token>` |
| Manual quantity | chosen when added; existing rows without one get a "pick the coin" prompt |
| Coin-denominated DeFi (staked/unbonding/rewards, Kamino/Navi/Lulo deposits, Axie/JUP DAO/KMNO staking) | the coin's key |
| Protocol position (LP, perps margin/PnL, Polymarket shares, leveraged vault net value, Zerion LP) | none — stored **position value** |

Receipt/rebasing tokens (aTokens, stETH, jlWSOL, kTokens): the price is fine,
the *quantity* grows between syncs — a sync-freshness issue, documented, not a
pricing one. Vault shares with a CoinGecko id price by id; without, they stay
position values.

### 2. One price table: `asset_prices`

```
asset_prices (
  price_key       text primary key references assets,
  usd             numeric,       -- last price a source reported; NEVER overwritten with null
  change_1h, change_24h, change_7d, change_30d, market_cap numeric,
  source          text,          -- the one source for this key
  updated_at      timestamptz,   -- when usd was last set
  last_attempt_at timestamptz,
  missing_since   timestamptz,   -- set when a refresh didn't return this key
  last_error      text
)
```

A source omitting a key (renamed id, truncated batch, outage) is not "no
price": the stored price stays, `missing_since` is set, and staleness is the
signal. A null would flip holdings to unpriced and bake that into
`portfolio_snapshots` forever.

### 3. Valuation

`value = qty × asset_prices[price_key].usd`; else the stored position value
(protocol positions only); else unpriced. Same rule everywhere, one cached
per-request read of `asset_prices`.

### 4. Refresh (one pass for the whole app)

1. Distinct `price_key`s of all holdings + watchlist.
2. CoinGecko ids → `/coins/markets`, 250 per call **with `per_page=250`**,
   asserting returned ≈ requested per batch.
3. `jup:` → Jupiter Price v3 (50/call); `hl:` → one Hyperliquid call;
   `coinbase:` → Coinbase spot.
4. Upsert `asset_prices` (never a null `usd`); log the run to `pricing_runs`.

One refresh at a time app-wide (CAS claim on `price_refresh_state`, the
existing pattern) — the post-sync passes of a Sync all's wallets must not each
fetch the same keys.

### 5. Sync

Adapters read balances and set `price_key` + qty. The EVM spam filter keeps
its exact rule and timing ("listed on CoinGecko and worth > $5", decided
**before** rows are written): the sync reads `asset_prices` and, for keys
missing or stale, makes **one batched call** (CAS-deduped) before deciding —
never "keep it until later", which would let spam rows appear as "—", count
as unpriced and be re-saved by carry-forward. A pricing failure keeps today's
behavior (tokens not listed, chain marked hard-failed, previous rows kept).
Sync still calls Jupiter's token search per Solana wallet for symbols,
liquidity and Shield (spam) — that's metadata, not pricing.

### 6. Display and staleness

- Assets rows group by `price_key`; name/symbol/icon from `assets`. Native
  USDC on 8 chains is one row; USDC.e its own.
- Every price, change and market cap shown comes from `asset_prices`.
- Staleness per asset (`updated_at`). The "oldest on screen" caption also
  counts position values by their wallet's last sync, since Refresh prices
  can't refresh those.

### 7. Analytics and snapshots

- `price_history` is keyed by `price_key` (today it uses a second scheme,
  `platform:contract | id`).
- The snapshot cron refreshes first (see Decisions), records price age, and
  also stores each held asset's daily close from `asset_prices` — history
  without extra `market_chart` calls.
- Expect a visible one-time step in daily totals on the phase-2 date
  (different, correct prices). It will be annotated.

### 8. Observability and tests

- `pricing_runs`: keys requested / returned / missing, calls made, duration,
  trigger — so "efficient" is measured, not claimed.
- Regression tests for the known collisions: DOG, the spoofed ORCA mint,
  Scroll bridged ETH vs native ETH, Celo native double-count, MORPHO
  exchange + contract.

## API budget

Demo plan: ~30/min, 10,000/month. ~300 distinct assets → 2 calls per refresh.
Post-sync pass ≤ 2 (deduped app-wide). Snapshot ~2/day. Well under 1,000/month
at normal use. Measured via `pricing_runs`.

## Phases

1. **Build alongside (hold branch until SQL is run).** DDL: `assets`,
   `asset_contracts`, `exchange_assets`, `asset_prices`, `pricing_runs`,
   `holdings.price_key` — **plus every `sync_*_holdings` function**, since each
   lists its insert columns explicitly (schema.sql ~357, 739, 821, 923…) and
   would silently drop `price_key`. Adapters set keys; refresh writes
   `asset_prices` in addition to today's stores. Nothing on screen changes.
   A diff script compares every holding's current value with
   `qty × asset_prices`, classifying each difference (source differs /
   staleness / mapping / no key), run after a Refresh, a Sync all and a cron;
   it lists every holding priced today by ticker that has no key (e.g. manual
   rows without a coin). Phase 2 waits until every difference is explained.
2. **Switch readers.** Valuation, Assets, Dashboard, wallet pages, movers read
   `asset_prices`; sync prices through it; assets group by key. Today's
   `prices` and `usd_override` keep being written, so rollback is a code
   revert. Verify: totals match phase 1's explained diff; CoinGecko calls per
   Sync all ≤ 5 in `pricing_runs`.
3. **Retire (irreversible; after several clean diffs).** Watchlist and
   Analytics read `asset_prices`; drop the ticker `prices` table,
   `token_registry` price/stat columns, `coin_market_data`, `coin_cache.usd`,
   `holdings.coingecko_id`; stop writing `usd_override` for coins. Rewrite
   CLAUDE.md's "two valuation paths" to the single path.
