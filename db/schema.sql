-- Schema for the cryptoport portfolio tracker.
-- Source of truth: run this once in the Supabase SQL editor. There is no
-- migration tool in this phase — edit this file and re-run the relevant
-- statements by hand when the schema changes.
--
-- This project shares a Postgres instance with csp-screener, whose anon key
-- is public. Every table below gets RLS enabled with NO policies: anon and
-- authenticated are denied by default, service_role bypasses RLS and is the
-- only way this app ever talks to the database (see src/lib/supabase.ts).

create schema if not exists cryptoport;

create extension if not exists pgcrypto;

create table cryptoport.wallets (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  address             text,
  chain               text not null,           -- 'BTC' | 'ETH' | 'SOL'
  mode                text not null,            -- 'manual' | 'auto'
  account             text default 'personal', -- 'personal' | 'biz'
  notes               text,
  active              boolean default true,
  last_refresh_at     timestamptz,
  last_refresh_status text,
  created_at          timestamptz default now()
);

create table cryptoport.holdings (
  id           uuid primary key default gen_random_uuid(),
  wallet_id    uuid not null references cryptoport.wallets(id) on delete cascade,
  ticker       text not null,
  qty          numeric,
  usd_override numeric,       -- manual_usd only; bypasses pricing entirely
  source       text not null, -- 'manual_qty' | 'manual_usd' | 'auto'
  contract     text,          -- contract / mint address, for auto rows
  updated_at   timestamptz default now()
);

create table cryptoport.prices (
  ticker         text primary key,
  usd            numeric,
  source         text,            -- 'coingecko' | 'coinbase' | 'jupiter'
  updated_at     timestamptz,
  -- 24h % change, e.g. 1.81 for +1.81%. Coinbase-sourced tickers: computed
  -- from the Exchange API's /products/{id}/stats (open vs last) — a call
  -- Coinbase doesn't otherwise need, added only for this. Jupiter-sourced
  -- tickers: free — tokens/v2/search (already called for pricing) returns
  -- stats24h.priceChange in the same response. Null when unavailable
  -- (a fetch failure, or a ticker with no 24h stats) — never blocks the
  -- price itself from refreshing, see prices.ts's refreshPrices.
  change_24h_pct numeric
);

-- Deny-by-default: no policies means no role can read or write through
-- PostgREST except service_role, which bypasses RLS entirely.
alter table cryptoport.wallets enable row level security;
alter table cryptoport.holdings enable row level security;
alter table cryptoport.prices enable row level security;

-- Custom schemas don't inherit Supabase's default public-schema grants.
-- Without these, service_role gets "permission denied for schema cryptoport"
-- from PostgREST regardless of RLS — this is a grants problem, not an RLS one.
grant usage on schema cryptoport to service_role;
grant all on all tables in schema cryptoport to service_role;
grant all on all sequences in schema cryptoport to service_role;
alter default privileges in schema cryptoport grant all on tables to service_role;
alter default privileges in schema cryptoport grant all on sequences to service_role;

-- No grants to anon or authenticated — the schema stays invisible to them.

-- Singleton row holding the site's Basic Auth login (see src/lib/authCredentials.ts
-- and src/proxy.ts). Lets the password be changed from the /settings page instead
-- of requiring an env var edit + redeploy.
create table cryptoport.app_credentials (
  id            int primary key default 1,
  username      text not null,
  password_hash text not null,     -- "<salt-hex>:<scrypt-hash-hex>"
  updated_at    timestamptz default now(),
  constraint app_credentials_singleton check (id = 1)
);

alter table cryptoport.app_credentials enable row level security;
grant all on cryptoport.app_credentials to service_role;

-- Seed row: username 'rai', password '7l4F0Rd0O3pneZZT' (the one already
-- handed to the user). Change it from /settings after first login instead of
-- editing this file.
insert into cryptoport.app_credentials (id, username, password_hash)
values (1, 'rai', 'bb31532bdadd2df47dc92295d5da7824:603980f64d578ad0aa1a90df3445fa1fd1dcc57c70db7af04611851841f51bfc8d0e84fcd30ab5ba1a73c60a39124babf2e358bbef62da2da18a06cf7df097d8');

-- C5/C6: auto adapters (Rabby+Hyperliquid for EVM, Jupiter for Solana).
--
-- category distinguishes a plain token balance from a DeFi position (e.g. a
-- Hyperliquid perps account's net value isn't a token — it has no qty/price,
-- just a dollar value). Defaults 'token' so every existing row (all
-- manually-entered) is classified without a backfill. Used by the Assets/
-- DeFi tabs later; not surfaced there yet.
alter table cryptoport.holdings
  add column category text not null default 'token'; -- 'token' | 'defi'

-- sync_auto_holdings (the RPC syncWalletHoldings() calls) is defined once,
-- further down this file — search for "Atomic delete+insert". It used to
-- be redundantly restated in full at every point its column list changed;
-- squashed to one canonical definition, see that comment for why. This
-- grant is kept in its original place since it really was applied at this
-- point in the schema's history (a later grant, to `authenticated`, is
-- alongside the canonical definition itself).
grant execute on function cryptoport.sync_auto_holdings(uuid, jsonb, text) to service_role;

-- EVM token registry: contract -> symbol/decimals per chain, refreshed from
-- CoinGecko's coins/list (keyless, ~20k tokens with per-chain contract
-- addresses in one call). Lets the Multicall3-based EVM sync check balances
-- for every known token in one batched on-chain read, without depending on
-- Rabby's indexer at all. `decimals` starts null and is filled in the first
-- time a chain's sync actually reads it on-chain (cheaper than a separate
-- CoinGecko call per token, and decimals never change once known).
create table cryptoport.token_registry (
  chain_id     text not null,   -- matches evmChains.ts EvmChain.id, e.g. 'eth', 'base'
  contract     text not null,   -- lowercase contract address
  symbol       text not null,
  coingecko_id text,
  decimals     int,
  updated_at   timestamptz default now(),
  primary key (chain_id, contract)
);

alter table cryptoport.token_registry enable row level security;
grant all on cryptoport.token_registry to service_role;

-- A holding's sub-chain, distinct from wallets.chain: one 'ETH' auto wallet
-- spans 15 EVM chains (eth, base, arb, ...), so grouping the Assets page by
-- chain needs this on the holding, not just the wallet. Null for manual
-- holdings and the pre-this-migration sync rows — the Assets query falls
-- back to the wallet's chain for those, and the next sync repopulates it
-- properly since sync_auto_holdings fully replaces a wallet's auto rows.
alter table cryptoport.holdings
  add column chain text; -- 'eth' | 'base' | ... | 'hyperliquid' | 'solana' | null

-- Chain logos (DeBank-style icons on the chain summary cards/section
-- headers), from CoinGecko's asset_platforms — refreshed alongside
-- token_registry by refreshTokenRegistry() (see coingecko.ts). Systematic,
-- not hand-copied: a new chain added to evmChains.ts gets its icon here
-- automatically on the next "Refresh token list" run, keyed by the same
-- coingeckoPlatform id already stored per chain.
create table cryptoport.chain_icons (
  chain_id   text primary key, -- evmChains.ts EvmChain.id, or 'solana' | 'hyperliquid'
  image_url  text not null,
  updated_at timestamptz default now()
);

alter table cryptoport.chain_icons enable row level security;
grant all on cryptoport.chain_icons to service_role;

-- Token logo support (DeBank-style icons next to each holding). CoinGecko
-- images are cached here (logos don't change, so this is fetched at most
-- once per contract, ever) — Solana icons come free from Jupiter's own
-- tokens/v2/search response instead and never touch this column.
alter table cryptoport.token_registry
  add column image_url text;

-- 24h % change per (chain, contract), from CoinGecko's simple/token_price
-- include_24hr_change=true — free in the same call multicallEvm.ts already
-- makes to price EVM holdings. This is what lets EVM tokens (which are
-- valued via holdings.usd_override, bypassing the ticker-keyed
-- cryptoport.prices table entirely, see valuation.ts) show a 24h change at
-- all. Unlike decimals/image_url above, this is volatile and rewritten on
-- every sync that holds the token, not fetched once and cached forever.
alter table cryptoport.token_registry
  add column change_24h_pct numeric;

-- Snapshotted onto the holding at sync time, same as usd_override — avoids
-- a join at render time and means a holding's icon survives even if its
-- token_registry row's cached image_url is later cleared/changed.
alter table cryptoport.holdings
  add column icon_url text;

-- Replaces the fixed personal/biz "account" enum with user-defined,
-- free-text tags — a wallet has at most one (nullable FK), and a tag is
-- created on the fly the first time its name is typed (see resolveTagId in
-- wallets/actions.ts) rather than managed on a separate admin page.
create table cryptoport.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz default now()
);

alter table cryptoport.tags enable row level security;
grant all on cryptoport.tags to service_role;

alter table cryptoport.wallets add column tag_id uuid references cryptoport.tags(id) on delete set null;
alter table cryptoport.wallets drop column account;

-- Sync duration tracking (shown in the wallets list and on the wallet
-- detail page) and BTC xpub script-type caching (see bitcoinXpub.ts) — a
-- plain "xpub" is ambiguous about which of the three address formats it
-- actually uses, so the first sync has to check all three; once one comes
-- back with real activity, it's cached here so every later sync goes
-- straight to the right one instead of re-scanning all three every time.
alter table cryptoport.wallets add column sync_started_at timestamptz;
alter table cryptoport.wallets add column last_sync_duration_ms integer;
alter table cryptoport.wallets add column btc_script_type text; -- 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | null

-- Cardano (ADA) auto-sync — see adapters/cardano.ts. Caches the stake
-- address a payment (addr1...) address resolves to, so later syncs skip
-- the resolution call. Never goes stale (a payment address's staking
-- credential is fixed at creation time), unlike BTC's script-type cache.
alter table cryptoport.wallets add column cardano_stake_address text;

-- Decouples "prices last refreshed" from per-wallet "Refreshed" — prices
-- are keyed by ticker, not wallet (see refreshPrices in prices.ts), so
-- stamping every active wallet's last_refresh_at/last_refresh_status on
-- every price refresh was conflating two different events into one column
-- (a wallet's real sync status kept getting overwritten by unrelated price
-- refreshes). One singleton row instead.
create table cryptoport.price_refresh_state (
  id           int primary key default 1,
  refreshed_at timestamptz,
  status       text,
  -- Per-lane live status/timing for the current or most recent refresh —
  -- {"coingecko": {"status": "running"|"done"|"error", "ms": number|null}, ...}
  -- for "coingecko" | "coinbase" | "evm" (see prices.ts's refreshPrices).
  -- Written incrementally as each lane finishes (not just once at the very
  -- end), which is what lets the UI show real per-lane progress while a
  -- refresh is still in flight, plus how long each one actually took once
  -- it's done.
  phases       jsonb,
  constraint price_refresh_state_singleton check (id = 1)
);

alter table cryptoport.price_refresh_state enable row level security;
grant all on cryptoport.price_refresh_state to service_role;

insert into cryptoport.price_refresh_state (id, refreshed_at, status) values (1, null, null);

-- Compare-and-set claim timestamp for refreshPricesAction/
-- refreshPricesForWalletAction, mirroring wallets.sync_started_at — a
-- refresh is global (this whole table is one singleton row), so this is
-- what lets a second click, a second tab, or a second user all agree on
-- whether a refresh is genuinely already running, and recovers a refresh
-- stuck showing "refreshing" forever if an earlier run's after() got
-- killed by the platform's own time limit.
alter table cryptoport.price_refresh_state add column started_at timestamptz;

-- Same singleton-row pattern as price_refresh_state, for
-- refreshTokenRegistryAction (Refresh token list) — this used to be
-- awaited directly with zero status tracking at all (a real, documented
-- CLAUDE.md "known offender": a Server Action that does real work
-- without the after()/CAS-claim/JobButton pattern every other sync
-- action in this app follows). token_registry itself (the actual rows
-- this refresh writes) is global, not per-user, so this state is too.
create table cryptoport.token_registry_state (
  id           int primary key default 1,
  refreshed_at timestamptz,
  status       text,
  started_at   timestamptz,
  constraint token_registry_state_singleton check (id = 1)
);

alter table cryptoport.token_registry_state enable row level security;
grant all on cryptoport.token_registry_state to service_role;

insert into cryptoport.token_registry_state (id, refreshed_at, status, started_at) values (1, null, null, null);

-- DeFi position breakdown (which protocol a position lives in, and a link
-- to it — DeBank/Rabby-style) — see adapters/jupiterPositions.ts, the first
-- adapter to populate these. Null for every plain token holding.
alter table cryptoport.holdings
  add column protocol text,
  add column protocol_url text;

-- Multi-tenant: Supabase Auth + real RLS, replacing the single shared
-- Basic Auth login. user_id is nullable for now, not "not null" yet —
-- existing rows have no owner until the one-time backfill script (run
-- after the first real signup) assigns them, which also tightens the
-- column to not null as its last step. holdings gets no user_id of its
-- own — it's always reached through its wallet, so its RLS policy is a
-- subquery against wallets.user_id instead of a duplicated column.
alter table cryptoport.wallets
  add column user_id uuid references auth.users(id) on delete cascade default auth.uid();

alter table cryptoport.tags
  add column user_id uuid references auth.users(id) on delete cascade default auth.uid();

-- Tag names are unique per user now, not globally — two different people
-- can both have a tag called "personal" without colliding.
alter table cryptoport.tags drop constraint if exists tags_name_key;
alter table cryptoport.tags add constraint tags_user_id_name_key unique (user_id, name);

create policy "wallets: owner only" on cryptoport.wallets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "tags: owner only" on cryptoport.tags
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "holdings: owner only" on cryptoport.holdings
  for all
  using (wallet_id in (select id from cryptoport.wallets where user_id = auth.uid()))
  with check (wallet_id in (select id from cryptoport.wallets where user_id = auth.uid()));

-- Currently only service_role has any grant on these tables at all (see
-- this file's original "deny by default" comment) — RLS restricts what a
-- role can see, but a role still needs an underlying grant to have
-- anything for RLS to apply itself to. anon gets nothing, deliberately.
--
-- Table grants alone 404'd with "permission denied for schema cryptoport"
-- (real bug, caught live) — Postgres also requires schema-level USAGE
-- before a role's table grants mean anything; the original file only ever
-- granted that to service_role, never authenticated.
grant usage on schema cryptoport to authenticated;
grant select, insert, update, delete on cryptoport.wallets to authenticated;
grant select, insert, update, delete on cryptoport.holdings to authenticated;
grant select, insert, update, delete on cryptoport.tags to authenticated;

-- Atomic delete+insert for one wallet's auto-sourced holdings, called by
-- syncWalletHoldings(). Doing this as a single PL/pgSQL function call makes
-- it one transaction: if the insert fails partway (bad row shape, etc.) the
-- delete rolls back too, so a failed sync never leaves a wallet with zero
-- holdings. The `source = 'auto'` predicate (never just wallet_id) is what
-- keeps this from ever touching a manually-entered holding in the same
-- wallet. Also stamps the wallet's refresh time/status in the same
-- transaction as the holdings themselves.
--
-- security definer (runs with elevated privileges), so RLS does NOT
-- protect it internally — without the ownership check below, any
-- authenticated user could call this RPC with someone else's wallet_id and
-- overwrite their holdings.
--
-- This function's column list grew across several migrations (chain,
-- icon_url, protocol/protocol_url were each added later, alongside the
-- holdings columns of the same names). Previously left as several
-- separate stacked `create or replace function` blocks scattered through
-- this file — each one redefining the whole function from scratch, with
-- nothing marking which was actually current — squashed to this one
-- canonical definition; only the very last such block was ever live.
create or replace function cryptoport.sync_auto_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

grant execute on function cryptoport.sync_auto_holdings(uuid, jsonb, text) to authenticated;

-- Basic Auth is fully replaced by Supabase Auth — this table (and its seed
-- row) is dead.
drop table if exists cryptoport.app_credentials;

-- Wallet sign-in (verify a MetaMask/Rabby/Phantom wallet by signature, then
-- use it to log in) needs a proof-of-ownership table that is deliberately
-- separate from cryptoport.wallets. wallets is portfolio-tracking data —
-- address has no uniqueness constraint, and many users can legitimately
-- track the same address (e.g. watching an influencer's wallet). Letting
-- that table grant sign-in access would mean tracking someone's address
-- could let their wallet sign in and see YOUR portfolio. linked_wallets is
-- the opposite: (chain, address) is globally unique, so a verified wallet
-- belongs to exactly one account, ever. The sign-in lookup (see
-- src/app/(auth)/walletActions.ts) runs before any session exists, so
-- auth.uid() is null and no RLS policy could authorize it — that one read
-- goes through serviceDb(), and only ever touches this identity mapping,
-- never wallets/holdings/tags.
create table cryptoport.linked_wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  chain       text not null, -- 'ETH' (one secp256k1 signature covers all 31 EVM chains) | 'SOL'
  address     text not null, -- EVM: lowercased. Solana: base58, case-sensitive.
  verified_at timestamptz not null default now(),
  unique (chain, address)
);

alter table cryptoport.linked_wallets enable row level security;
grant all on cryptoport.linked_wallets to service_role;

create policy "linked_wallets: owner only" on cryptoport.linked_wallets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Same schema-usage gap as before would 403 this table too if omitted (see
-- the "permission denied for schema cryptoport" fix above) — grant is
-- explicit here from the start.
grant usage on schema cryptoport to authenticated;
grant select, insert, update, delete on cryptoport.linked_wallets to authenticated;

-- Daily per-user portfolio value history, for the Dashboard's value-over-
-- time chart (src/lib/snapshots.ts). There is no historical data anywhere
-- else in this schema — every other table is "current state, overwritten
-- in place" — so this chart's clock starts the day this table starts being
-- written to, not retroactively. Written exclusively by a Vercel Cron
-- (src/app/api/cron/snapshot/route.ts) via service_role, once a day, one
-- row per (user, day) — never by the app itself, hence no insert/update
-- grant to authenticated below, read-only same as prices/token_registry
-- are for everyone but written-only-by-us.
create table cryptoport.portfolio_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  snapshot_date  date not null,
  total_usd      numeric not null,
  unpriced_count int not null default 0,
  created_at     timestamptz not null default now(),
  unique (user_id, snapshot_date)
);

alter table cryptoport.portfolio_snapshots enable row level security;
grant all on cryptoport.portfolio_snapshots to service_role;
grant select on cryptoport.portfolio_snapshots to authenticated;

create policy "portfolio_snapshots: owner only" on cryptoport.portfolio_snapshots
  for select using (user_id = auth.uid());

-- Same shape as portfolio_snapshots, one level down: per-wallet daily
-- value, for Analytics' per-wallet breakdown (src/lib/snapshots.ts writes
-- both tables in the same cron pass, from the same holdings/prices read,
-- so a wallet's row and the user total it rolls into can never disagree).
-- Ownership via a subquery on wallets.user_id (same pattern as
-- holdings/RLS), not a duplicated user_id column here.
create table cryptoport.wallet_snapshots (
  id             uuid primary key default gen_random_uuid(),
  wallet_id      uuid not null references cryptoport.wallets(id) on delete cascade,
  snapshot_date  date not null,
  total_usd      numeric not null,
  unpriced_count int not null default 0,
  created_at     timestamptz not null default now(),
  unique (wallet_id, snapshot_date)
);

alter table cryptoport.wallet_snapshots enable row level security;
grant all on cryptoport.wallet_snapshots to service_role;
grant select on cryptoport.wallet_snapshots to authenticated;

create policy "wallet_snapshots: owner only" on cryptoport.wallet_snapshots
  for select using (
    wallet_id in (select id from cryptoport.wallets where user_id = auth.uid())
  );

create index wallet_snapshots_wallet_date_idx
  on cryptoport.wallet_snapshots (wallet_id, snapshot_date);

-- Cached daily historical token prices, keyed by however priceKey.ts
-- resolved the holding: "<coin-id>" (e.g. "bitcoin") for a native token, or
-- "<platform>:<contract>" (e.g. "ethereum:0xc02aaa...") for a contract-
-- based one — see src/lib/priceHistory.ts, the only writer (an explicit,
-- user-triggered "Backfill history" action on /analytics, not a cron).
-- Market data, not user data: shared across all users rather than
-- duplicated per account — select is open to any authenticated user, same
-- access level as token_registry/chain_icons.
--
-- One row per key with the whole year's series as jsonb ({"2026-01-01":
-- 2000.12, ...}), not one row per (key, day): a portfolio with 100+
-- distinct tokens would otherwise be ~36,500 rows, past PostgREST's
-- default 1000-row response cap — reading it back would silently truncate
-- instead of erroring. A row per key keeps a read to however many tokens
-- are held, comfortably under that cap, and is a single request instead of
-- a paginated one — "every click as fast as possible" applies to the read
-- path, not just the backfill itself.
create table cryptoport.price_history (
  coingecko_key text primary key,
  series        jsonb not null,
  fetched_at    timestamptz not null default now()
);

alter table cryptoport.price_history enable row level security;
grant all on cryptoport.price_history to service_role;
grant select on cryptoport.price_history to authenticated;

create policy "price_history: readable by all signed-in users"
  on cryptoport.price_history for select to authenticated using (true);

-- Asset market cap for the Assets page's sortable "Market Cap" column —
-- purely informational, never fed into valuation. Two write paths, same
-- split as change_24h_pct above: token_registry.market_cap for EVM
-- contract-based holdings (free in the same CoinGecko call multicallEvm.ts
-- already makes to price them), prices.market_cap for everything else
-- (native/major tickers and non-EVM contract-based tokens, resolved via
-- priceKey.ts's resolveCoingeckoKey — see prices.ts's
-- refreshTickerMarketCaps). Both volatile, rewritten on every
-- sync/refresh that touches the asset, same lifetime as price/24h-change.
alter table cryptoport.token_registry
  add column market_cap numeric;

alter table cryptoport.prices
  add column market_cap numeric;

-- Per-wallet transaction history for the /transactions tab. Explicit
-- "Sync transactions" action, not live/on every page load (rate limits +
-- "every click fast") and not folded into syncWalletHoldings (transaction
-- fetching is slower and shouldn't make the existing balance sync worse) —
-- see src/lib/adapters/transactionDispatch.ts, the single dispatch point
-- for which free source covers which chain.
--
-- `leg` (not just wallet_id/chain/tx_hash) is part of the uniqueness key
-- because one transaction can move more than one asset for this wallet at
-- once — an EVM tx moving native ETH *and* a token in the same call, or a
-- Solana swap (token A out, token B in) — and each becomes its own row
-- sharing the same tx_hash. Capped at each source's own per-call limit
-- (not unbounded backfill, not further paginated) — see etherscan.ts/
-- bitcoinShared.ts/solanaTx.ts's own caps.
create table cryptoport.transactions (
  id           uuid primary key default gen_random_uuid(),
  wallet_id    uuid not null references cryptoport.wallets(id) on delete cascade,
  chain        text not null,        -- sub-chain: 'bitcoin' | 'solana' | 'eth' | 'arb' | ...
  tx_hash      text not null,
  leg          int not null default 0,
  occurred_at  timestamptz not null,
  direction    text not null,        -- 'in' | 'out' | 'self' | 'unknown'
  ticker       text,
  amount       numeric,
  counterparty text,
  explorer_url text,
  fee          numeric,
  synced_at    timestamptz not null default now(),
  unique (wallet_id, chain, tx_hash, leg)
);

alter table cryptoport.transactions enable row level security;
grant all on cryptoport.transactions to service_role;
-- `for all` + insert/update/delete granted (not just select) — the sync
-- action writes through the signed-in user's own client (userDb(), same
-- as syncWalletHoldings' write path), matching holdings' own "owner only"
-- policy shape exactly. select-only here was a real bug: the very first
-- live sync 403'd with "permission denied for table transactions."
grant select, insert, update, delete on cryptoport.transactions to authenticated;

create policy "transactions: owner only" on cryptoport.transactions
  for all
  using (wallet_id in (select id from cryptoport.wallets where user_id = auth.uid()))
  with check (wallet_id in (select id from cryptoport.wallets where user_id = auth.uid()));

create index transactions_wallet_occurred_idx
  on cryptoport.transactions (wallet_id, occurred_at desc);

-- Separate from last_refresh_at/last_refresh_status (holdings sync) —
-- "staleness is two independent things" already applied to prices vs.
-- wallet sync, now extended to a third: transaction sync has its own
-- cadence and can fail independently of a holdings sync.
alter table cryptoport.wallets
  add column tx_synced_at timestamptz,
  add column tx_sync_status text;

-- Compare-and-set claim timestamp for syncWalletTransactions, mirroring
-- sync_started_at above (holdings sync) — its own column, not a reused
-- one, because a transaction sync and a holdings sync are independent
-- jobs that can each be mid-run on their own schedule.
alter table cryptoport.wallets add column tx_sync_started_at timestamptz;

-- 1h/7d/30d % change for the Assets page's optional extra columns
-- (checkbox-gated — see AssetsTable.tsx). Same two-write-path split as
-- change_24h_pct/market_cap above: token_registry for EVM contract-based
-- holdings, prices for everything else. Narrower coverage than 24h,
-- though, live-verified (2026-09): only /coins/markets returns these
-- windows — simple/price and simple/token_price (the endpoints that
-- actually price EVM contract tokens and Solana SPL tokens) cap out at
-- 24h change. Both token types get a second, best-effort lookup layered
-- on top instead — resolved to a coingecko_id via token_registry (see
-- multicallEvm.ts's and prices.ts's refreshCoinGeckoTickers' own doc
-- comments; token_registry.chain_id = "solana" for SPL mints, populated
-- by refreshTokenRegistry's own Solana loop from the same coins/list
-- response the EVM loop already uses) — correctly left null rather than
-- guessed at when a token has no cached coingecko_id yet.
alter table cryptoport.token_registry
  add column change_1h_pct numeric,
  add column change_7d_pct numeric,
  add column change_30d_pct numeric;

alter table cryptoport.prices
  add column change_1h_pct numeric,
  add column change_7d_pct numeric,
  add column change_30d_pct numeric;

-- Watchlist: track tokens you don't hold, across multiple named lists (see
-- (app)/watchlist/). Three tables:
--   watchlists       — one row per named list, owner-only RLS like wallets.
--   watchlist_items  — coingecko_id-keyed (never ticker-keyed — CoinGecko
--                       returns 20+ distinct coins for a symbol like
--                       "PEPE" alone; pricing by ticker would silently mix
--                       one coin's price onto another's row, the same
--                       class of bug valuation.ts's "KNOWN GAP" comment
--                       already documents for Solana holdings). Identity
--                       fields (ticker/name/image_url) are captured at
--                       add-time from the search result the user actually
--                       picked, not re-derived later.
--   coin_market_data — shared/global market data (price + 1h/24h/7d/30d
--                       change + market cap), refreshed alongside the
--                       existing holdings-driven price refresh (see
--                       wallets/actions.ts's runPriceRefresh) via the same
--                       "Refresh prices" button, not a second mechanism.
--                       Same "service_role writes, authenticated reads"
--                       shape as price_history.
create table cryptoport.watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name       text not null,
  created_at timestamptz not null default now()
);
alter table cryptoport.watchlists enable row level security;
grant all on cryptoport.watchlists to service_role;
grant select, insert, update, delete on cryptoport.watchlists to authenticated;
create policy "watchlists: owner only" on cryptoport.watchlists
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- unique(watchlist_id, coingecko_id), not (watchlist_id, ticker) — so two
-- genuinely different coins that happen to share a symbol can both be
-- watched in the same list.
create table cryptoport.watchlist_items (
  id           uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references cryptoport.watchlists(id) on delete cascade,
  coingecko_id text not null,
  ticker       text not null,
  name         text not null,
  image_url    text,
  created_at   timestamptz not null default now(),
  unique (watchlist_id, coingecko_id)
);
alter table cryptoport.watchlist_items enable row level security;
grant all on cryptoport.watchlist_items to service_role;
grant select, insert, update, delete on cryptoport.watchlist_items to authenticated;
create policy "watchlist_items: owner only" on cryptoport.watchlist_items
  for all
  using (watchlist_id in (select id from cryptoport.watchlists where user_id = auth.uid()))
  with check (watchlist_id in (select id from cryptoport.watchlists where user_id = auth.uid()));
create index watchlist_items_watchlist_idx on cryptoport.watchlist_items (watchlist_id);

-- No foreign key from watchlist_items.coingecko_id to this table's own
-- primary key, deliberately — a newly-added item is saved before its
-- market-data row exists (see (app)/watchlist/actions.ts's
-- addWatchlistItem), so a FK here would make that insert fail. queries.ts's
-- getWatchlistItems joins the two in code instead of via a PostgREST
-- embedded-relationship select.
create table cryptoport.coin_market_data (
  coingecko_id text primary key,
  price_usd    numeric,
  change_1h    numeric,
  change_24h   numeric,
  change_7d    numeric,
  change_30d   numeric,
  market_cap   numeric,
  updated_at   timestamptz not null default now()
);
alter table cryptoport.coin_market_data enable row level security;
grant all on cryptoport.coin_market_data to service_role;
grant select on cryptoport.coin_market_data to authenticated;
create policy "coin_market_data: readable by all signed-in users"
  on cryptoport.coin_market_data for select to authenticated using (true);

-- Lets a manual holding (chain/contract both null — see the base table's
-- own comment) carry an explicit CoinGecko identity, picked via the same
-- searchCoins()/pickBestMatch() infra the Watchlist uses (CoinSearchInput).
-- resolveCoingeckoKey (priceKey.ts) checks this before any chain/contract
-- inference — it's the strongest possible signal, since it names the exact
-- coin instead of guessing off a bare ticker. Fixes a real bug: a manually-
-- added "DOG" (a Bitcoin Rune) was priced off Coinbase's own unrelated
-- "DOG" — same ticker, different asset, no way to tell them apart from a
-- bare symbol alone.
alter table cryptoport.holdings
  add column coingecko_id text;

-- A second, disjoint sync-owned holdings.source — Zerion-backed EVM DeFi
-- positions (adapters/zerionDefi.ts), deliberately distinct from 'auto'
-- (the regular multicall/adapter sync) so the two syncs' own delete-then-
-- insert functions (sync_auto_holdings below vs. sync_defi_holdings) can
-- never clobber each other's rows — 'auto' already covers Hyperliquid's own
-- DeFi-category holdings on the EVM side, and a naive shared source would
-- mean each sync silently deleting the other's data on its next run.
-- holdings.source has no CHECK constraint (see its own comment above),
-- just this documentation update.
-- holdings.source: 'manual_qty' | 'manual_usd' | 'auto' | 'auto_defi'

-- Same "staleness is two/three independent things" pattern as
-- tx_synced_at/tx_sync_status/tx_sync_started_at above, extended to a
-- fourth independent job: DeFi-position sync (Zerion) has its own cadence
-- and can fail independently of both the holdings sync and the transaction
-- sync — see syncWalletDefi (wallets/actions.ts) and SyncDefiButton.tsx.
alter table cryptoport.wallets
  add column defi_sync_status text,
  add column defi_sync_started_at timestamptz,
  add column defi_synced_at timestamptz,
  add column defi_sync_duration_ms integer;

-- Near-duplicate of sync_auto_holdings above, scoped to source='auto_defi'
-- and writing defi_synced_at/defi_sync_status instead of
-- last_refresh_at/last_refresh_status — see this column's own comment on
-- cryptoport.wallets for why this needs to be a fully separate function
-- rather than a parameterized variant of sync_auto_holdings: the two must
-- never share a delete predicate.
create or replace function cryptoport.sync_defi_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_defi';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_defi',
    h->>'contract',
    coalesce(h->>'category', 'defi'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set defi_synced_at = now(), defi_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

grant execute on function cryptoport.sync_defi_holdings(uuid, jsonb, text) to authenticated;
grant execute on function cryptoport.sync_defi_holdings(uuid, jsonb, text) to service_role;

-- Connect an exchange account (Coinbase first, built to take more later) as
-- a wallet with no on-chain address — see the "Connect Coinbase" plan.
-- `provider` discriminates it from every existing on-chain wallet; null for
-- all of them. address stays null for these rows (nothing on-chain to scan).
alter table cryptoport.wallets
  add column provider text,
  add column exchange_sync_status text,
  add column exchange_sync_started_at timestamptz,
  add column exchange_synced_at timestamptz,
  add column exchange_sync_duration_ms integer;

-- The first per-user secret this app has ever stored (every prior
-- "credential" was an app-wide env var, or the now-dropped app_credentials
-- singleton — see that table's own comment above). Deliberately its own
-- table, not columns on wallets, and deliberately NO grant to `authenticated`
-- at all — deny-by-default, same posture as this schema's other
-- service-role-only tables. The only legitimate reader is serviceDb() inside
-- a Server Action that has already done its own requireUser() + ownership
-- check (see connectCoinbase/syncCoinbaseHoldings/disconnectExchange in
-- wallets/actions.ts) — there is no reason a client ever reads this row
-- directly, so it isn't given the chance to. encrypted_secret is AES-256-GCM
-- ciphertext (see cryptoSecrets.ts), never plaintext at rest.
create table cryptoport.exchange_connections (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null unique references cryptoport.wallets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  provider text not null,         -- 'coinbase' for now
  key_name text not null,         -- an id, not a secret on its own
  encrypted_secret text not null, -- the PEM private key, encrypted
  created_at timestamptz default now()
);
alter table cryptoport.exchange_connections enable row level security;
grant all on cryptoport.exchange_connections to service_role;

-- A fourth disjoint holdings source (see sync_auto_holdings/sync_defi_holdings
-- above) — never shares a delete predicate with 'auto' or 'auto_defi'.
-- holdings.source: 'manual_qty' | 'manual_usd' | 'auto' | 'auto_defi' | 'auto_exchange'
create or replace function cryptoport.sync_exchange_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_exchange';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_exchange',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set exchange_synced_at = now(), exchange_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

grant execute on function cryptoport.sync_exchange_holdings(uuid, jsonb, text) to authenticated;
grant execute on function cryptoport.sync_exchange_holdings(uuid, jsonb, text) to service_role;

-- Ticker-keyed sibling of token_registry.image_url: a bare symbol (no
-- contract/chain to disambiguate it, unlike token_registry) fetched at most
-- once per ticker, ever, then reused by every wallet/user — see
-- resolveTickerIcons in adapters/coingecko.ts. Currently populated only by
-- exchange adapters (Coinbase's own currency list), never from an
-- arbitrary/user-typed ticker.
create table cryptoport.ticker_icons (
  ticker     text primary key,
  image_url  text not null,
  updated_at timestamptz not null default now()
);

alter table cryptoport.ticker_icons enable row level security;
grant all on cryptoport.ticker_icons to service_role;

-- A wallet's single nullable tag_id FK (above) couldn't express tags that
-- span independent dimensions at once (e.g. 'personal' + 'soft wallet') —
-- replaced with a many-to-many join table, same "own user_id + owner-only
-- policy" convention every per-user table in this file uses, rather than a
-- subquery against wallets.user_id. Existing single tags are carried over
-- before tag_id is dropped — no wallet loses its tag in the migration.
create table cryptoport.wallet_tags (
  wallet_id  uuid not null references cryptoport.wallets(id) on delete cascade,
  tag_id     uuid not null references cryptoport.tags(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz default now(),
  primary key (wallet_id, tag_id)
);
alter table cryptoport.wallet_tags enable row level security;
create policy "wallet_tags: owner only" on cryptoport.wallet_tags
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
grant all on cryptoport.wallet_tags to service_role;
grant select, insert, update, delete on cryptoport.wallet_tags to authenticated;

insert into cryptoport.wallet_tags (wallet_id, tag_id, user_id)
select id, tag_id, user_id from cryptoport.wallets where tag_id is not null
on conflict do nothing;

alter table cryptoport.wallets drop column tag_id;

-- Leveraged-position detail — see AdapterHolding.position_* in
-- adapters/types.ts for why these are named columns (not a generic blob)
-- and why usd_override is stamped from PnL, not notional or margin. Null
-- for every holding except an open perp/futures position (currently only
-- hyperliquid.ts; shaped to also cover Coinbase's CFM perp futures, already
-- flagged once before as a known gap, without a second migration).
alter table cryptoport.holdings
  add column position_side text,
  add column position_leverage numeric,
  add column position_entry_price numeric,
  add column position_liquidation_price numeric,
  add column position_pnl_usd numeric;

-- Re-defined (not a new function) to also pass through the position_*
-- columns above — every sync RPC insert list needs the same five columns
-- added, so all three are redefined here together rather than as three
-- separate migrations.
create or replace function cryptoport.sync_auto_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_defi_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_defi';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_defi',
    h->>'contract',
    coalesce(h->>'category', 'defi'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set defi_synced_at = now(), defi_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_exchange_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_exchange';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd)
  select
    p_wallet_id, h->>'ticker', (h->>'qty')::numeric, (h->>'usd_override')::numeric,
    'auto_exchange', h->>'contract', coalesce(h->>'category', 'token'), h->>'chain',
    h->>'icon_url', h->>'protocol', h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set exchange_synced_at = now(), exchange_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

-- Display-only detail — see AdapterHolding.display_label/.protocol_section
-- in adapters/types.ts. Never used for grouping/pricing (both stay keyed on
-- ticker/protocol as always) — purely how a holding renders. Null for every
-- holding except one an adapter explicitly labeled/sub-grouped (currently
-- only hyperliquid.ts, breaking its account into Deposit/Perpetuals/Yield/
-- Rewards the way DeBank's own UI already does).
alter table cryptoport.holdings
  add column display_label text,
  add column protocol_section text;

-- Re-defined again (not new functions) to also pass through the two
-- columns above, same reasoning as the position_* re-definition before
-- this one — every sync RPC insert list needs the same columns added.
create or replace function cryptoport.sync_auto_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     display_label, protocol_section)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_defi_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_defi';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     display_label, protocol_section)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_defi',
    h->>'contract',
    coalesce(h->>'category', 'defi'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set defi_synced_at = now(), defi_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_exchange_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_exchange';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     display_label, protocol_section)
  select
    p_wallet_id, h->>'ticker', (h->>'qty')::numeric, (h->>'usd_override')::numeric,
    'auto_exchange', h->>'contract', coalesce(h->>'category', 'token'), h->>'chain',
    h->>'icon_url', h->>'protocol', h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set exchange_synced_at = now(), exchange_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

-- Percentage-move sibling of position_pnl_usd — see AdapterHolding's own
-- doc comment for why this isn't derived from the dollar figure (Hyperliquid
-- and Polymarket each report it directly, on a different basis). Re-defined
-- (not new functions) to pass it through, same reasoning as every other
-- position_* addition above.
alter table cryptoport.holdings add column position_pnl_percent numeric;

create or replace function cryptoport.sync_auto_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_defi_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_defi';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_defi',
    h->>'contract',
    coalesce(h->>'category', 'defi'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set defi_synced_at = now(), defi_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_exchange_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_exchange';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    p_wallet_id, h->>'ticker', (h->>'qty')::numeric, (h->>'usd_override')::numeric,
    'auto_exchange', h->>'contract', coalesce(h->>'category', 'token'), h->>'chain',
    h->>'icon_url', h->>'protocol', h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set exchange_synced_at = now(), exchange_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

-- Trend Finder: one row per coin, its raw CoinGecko category names. Cached
-- because /coins/{id} is the most rate-limited call in the flow (429s at 3s
-- spacing, verified live) and category membership changes on the order of
-- months. Global/shared reference data, not per-user — same shape as
-- token_registry/chain_icons (RLS enabled, no policy, service_role only),
-- not the user_id+owner-policy pattern. Lazy-populated on read (fetch on
-- miss, upsert), same precedent as resolveTickerIcons in coingecko.ts, but
-- with a 7-day TTL (unlike that one) since a stale category list silently
-- changes which peers get shown, not just a cosmetic icon. Category market
-- caps/24h changes are deliberately NOT cached alongside this — those are
-- live financial data (Data Correctness rule) and are fetched fresh on
-- every render via /coins/categories instead.
create table cryptoport.coin_categories (
  coingecko_id text primary key,
  categories   jsonb not null,
  updated_at   timestamptz default now()
);
alter table cryptoport.coin_categories enable row level security;
grant all on cryptoport.coin_categories to service_role;

-- Per-user display preferences (2026-09-22). timezone: IANA name; null =
-- Automatic (the browser-detected zone, sent in the cryptoport_tz cookie).
-- Resolution: saved > detected > UTC (src/lib/preferences.ts). Only DISPLAY
-- uses it — stored data and computation boundaries stay UTC.
create table cryptoport.user_preferences (
  user_id     uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  timezone    text,
  updated_at  timestamptz not null default now()
);
alter table cryptoport.user_preferences enable row level security;
grant all on cryptoport.user_preferences to service_role;
grant select, insert, update, delete on cryptoport.user_preferences to authenticated;
create policy "user_preferences: owner only" on cryptoport.user_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===========================================================================
-- Crypto fundamentals screener (docs/screener/). Every table prefixed
-- screener_; src/lib/screener/* is never imported by portfolio code. RLS
-- enabled, no policies (deny-by-default, service_role only) — this Postgres
-- is shared with csp-screener, whose anon key is public.
--
-- History: Phase 1 created these tables (2026-09-22). The storage fix the
-- same day (1.7 GB on a 0.5 GB tier, 95% of it this snapshot table's
-- per-row provenance JSONB) truncated the backfilled rows and ran:
--   step A  — screener_runs.kind/provenance, snapshots.contributing_slugs/
--             provenance_override, snapshots.run_id NOT NULL
--   step A2 — screener_unmatched (change-only log) + observed_at index
--   step B  — (after the lean-provenance deploy) drop snapshots.provenance
--             and the old per-run screener_unmatched_log
-- Statements below are the end state; the two legacy objects step B drops
-- are kept, commented, at the bottom of this section.
-- ===========================================================================

create table cryptoport.screener_assets (
  id                 uuid primary key default gen_random_uuid(),
  gecko_id           text not null unique,
  defillama_slug     text,   -- first contributing slug only; the full list is per snapshot row
  name               text not null,
  ticker             text not null,
  sector             text,
  status             text not null default 'active' check (status in ('active','delisted','dead','unknown')),
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  status_changed_at  timestamptz
);

-- One row per pipeline execution: the daily live job (kind 'live') or a
-- manual backfill (kind 'backfill'). `provenance` is the run's manifest
-- (field -> {source, endpoint}, plus fetched_at) — see
-- src/lib/screener/provenance.ts. Gap detection and "latest run" reads
-- filter kind = 'live'.
create table cryptoport.screener_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running','ok','partial','error')),
  universe_size  int,
  matched_count  int,
  unmatched_count int,
  notes          jsonb,
  kind           text not null default 'live'
                   constraint screener_runs_kind_check check (kind in ('live', 'backfill')),
  provenance     jsonb,
  -- Added 2026-09-23. true = CoinGecko was unavailable, so the live snapshot
  -- was written from DefiLlama only (price, fees, revenue, TVL) with market
  -- cap / FDV / supply / volume null — nothing is rated that day, but the
  -- day isn't lost. status stays 'ok'. Details in notes.degradation. A
  -- complete run beats a degraded one for the same UTC day (runSelection.ts);
  -- Phase 4 excludes days whose run is degraded.
  degraded       boolean not null default false
);

-- Append-only, point-in-time. A field's provenance = its run's manifest
-- (screener_runs.provenance), overridden per field by provenance_override
-- when that row's value came from somewhere else (e.g. a backfilled price
-- that fell back to CoinGecko). run_id is NOT NULL on purpose (a tripwire
-- against the old run-less backfill); note its FK is still ON DELETE SET
-- NULL from Phase 1, so deleting a referenced run errors — runs are never
-- deleted (the archive keeps them). Rows older than 400 days are moved to
-- local Parquet monthly by scripts/screener-archive.ts.
create table cryptoport.screener_asset_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  asset_id              uuid not null references cryptoport.screener_assets(id) on delete cascade,
  observed_at           timestamptz not null default now(),
  run_id                uuid not null references cryptoport.screener_runs(id) on delete set null,
  is_backfilled         boolean not null default false,
  price_usd             double precision,
  market_cap_usd        double precision,
  fdv_usd               double precision,
  circulating_supply    double precision,
  total_supply          double precision,
  max_supply            double precision,
  tvl_usd               double precision,
  fees_24h              double precision,
  fees_7d               double precision,
  fees_30d              double precision,
  fees_1y               double precision,
  revenue_24h           double precision,
  revenue_7d            double precision,
  revenue_30d           double precision,
  revenue_1y            double precision,
  holders_revenue_24h   double precision,
  holders_revenue_30d   double precision,
  volume_24h_usd        double precision,
  contributing_slugs    text[],
  provenance_override   jsonb
);
create index screener_asset_snapshots_asset_observed_idx on cryptoport.screener_asset_snapshots (asset_id, observed_at desc);
create index screener_asset_snapshots_run_idx on cryptoport.screener_asset_snapshots (run_id);
-- date-first scans: "every asset as of date D" (Phase 2/4) and the archive's "older than N days"
create index screener_asset_snapshots_observed_idx on cryptoport.screener_asset_snapshots (observed_at);
-- one backfilled row per asset per UTC day (the Phase 1 duplication incident)
create unique index screener_asset_snapshots_backfilled_asset_date_uidx
  on cryptoport.screener_asset_snapshots (asset_id, ((observed_at at time zone 'UTC')::date))
  where is_backfilled;

create table cryptoport.screener_field_conflicts (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references cryptoport.screener_assets(id) on delete cascade,
  observed_at  timestamptz not null,
  field_name   text not null,
  source_a     text not null,
  value_a      double precision,
  source_b     text not null,
  value_b      double precision,
  pct_diff     double precision,
  run_id       uuid references cryptoport.screener_runs(id) on delete set null
);
create unique index screener_field_conflicts_asset_run_field_uidx
  on cryptoport.screener_field_conflicts (asset_id, run_id, field_name);

-- Change-only unmatched log: one row per continuous interval an item stays
-- unmatched (opened the first run it appears, resolved the first run it's
-- gone) — replaces rewriting all ~7.3K unmatched items every run.
create table cryptoport.screener_unmatched (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('no_gecko_id','no_fee_data','no_coingecko_market_data')),
  identifier         text not null,
  reason             text,
  first_seen_run_id  uuid not null references cryptoport.screener_runs(id),
  first_seen_at      timestamptz not null default now(),
  resolved_run_id    uuid references cryptoport.screener_runs(id),
  resolved_at        timestamptz
);
create unique index screener_unmatched_open_uidx
  on cryptoport.screener_unmatched (kind, identifier) where resolved_run_id is null;

-- Phase 2a (2026-09-22). One row per distinct config (src/lib/screener/config.ts),
-- keyed by the SHA-256 of its canonical JSON; every derived row points here.
create table cryptoport.screener_scoring_config_versions (
  id           uuid primary key default gen_random_uuid(),
  config_hash  text not null unique,
  config       jsonb not null,
  created_at   timestamptz not null default now(),
  notes        text
);

-- One row per live run. Inputs whose history doesn't exist for free (BTC
-- dominance, open interest) get their 4-week change from this table's own
-- earlier rows; until 28 days exist those are null and the rules needing
-- them are not evaluable (rules jsonb: fired true|false|null).
create table cryptoport.screener_regime_snapshots (
  run_id                           uuid primary key references cryptoport.screener_runs(id),
  config_version_id                uuid not null references cryptoport.screener_scoring_config_versions(id),
  computed_at                      timestamptz not null default now(),
  label                            text not null check (label in ('RISK_OFF','BTC_LED','ROTATION','FROTH','NEUTRAL')),
  btc_dominance_pct                double precision,
  btc_dominance_4w_change_pts      double precision,
  eth_btc_4w_change_pct            double precision,
  stablecoin_supply_usd            double precision,
  stablecoin_supply_30d_change_pct double precision,   -- chosen source: /stablecoincharts/all, last complete day vs 30 days earlier
  stablecoin_supply_30d_change_pct_prevmonth double precision,  -- /stablecoins circulatingPrevMonth; comparison only (added 2026-09-22)
  avg_funding_rate_hourly          double precision,
  funding_percentile_1y            double precision,
  btc_open_interest_usd            double precision,
  btc_oi_4w_change_pct             double precision,
  btc_price_4w_change_pct          double precision,
  rules                            jsonb not null,
  provenance                       jsonb not null
);

-- Per-asset metrics + kill-filter gates for one live run (derived; kept 90
-- days, then archived to Parquet and deleted by scripts/screener-archive.ts).
-- The composite primary key is the only index. dilution_rate is MEASURED
-- from live supply snapshots (the only one allowed to drive a risk tier);
-- dilution_rate_implied comes from backfilled mcap / price and is display
-- only. The history-derived columns are filled from Phase 2b.
create table cryptoport.screener_asset_metrics (
  run_id                 uuid not null references cryptoport.screener_runs(id),
  asset_id               uuid not null references cryptoport.screener_assets(id) on delete cascade,
  config_version_id      uuid not null references cryptoport.screener_scoring_config_versions(id),
  computed_at            timestamptz not null default now(),
  sector_bucket          text,
  fees_ann               double precision,
  rev_ann                double precision,
  holders_rev_ann        double precision,
  pf_fd                  double precision,
  pf_circ                double precision,
  ps_fd                  double precision,
  ps_circ                double precision,
  capture                double precision,
  buyback_yield          double precision,
  float_ratio            double precision,
  mc_tvl                 double precision,
  size_log_mcap          double precision,
  mom_3w                 double precision,
  mom_12w                double precision,
  beta_btc               double precision,
  dilution_rate          double precision,
  dilution_rate_implied  double precision,
  rev_growth             double precision,
  rev_90d_change         double precision,
  rated                  boolean not null,
  gate_status            jsonb not null,
  primary key (run_id, asset_id)
);

-- Phase 3 (2026-09-23). One row per RATED asset per live run: Quality &
-- Risk tier (every rule's outcome + input in quality_risk_rules — a null
-- input doesn't fire), Score B (mean of the momentum legs' percentile ranks
-- across all rated assets) and its percentile, raw and displayed grade (High
-- risk caps the displayed grade at C), momentum tercile, setup tag,
-- confidence, and market-cap size bucket. Scores are null (never 0) for an
-- asset with neither momentum leg. Derived; kept 90 days, then archived and
-- deleted by scripts/screener-archive.ts, like metrics. The run-level size
-- check lives in the run's notes.derivations.scores.
create table cryptoport.screener_asset_scores (
  run_id              uuid not null references cryptoport.screener_runs(id),
  asset_id            uuid not null references cryptoport.screener_assets(id) on delete cascade,
  config_version_id   uuid not null references cryptoport.screener_scoring_config_versions(id),
  computed_at         timestamptz not null default now(),
  quality_risk_tier   text not null check (quality_risk_tier in ('pass','caution','high_risk')),
  quality_risk_rules  jsonb not null,
  rules_evaluable     smallint not null,
  timing_score        double precision,
  timing_percentile   double precision,
  timing_grade_raw    text check (timing_grade_raw in ('A','B','C','D','F')),
  timing_grade        text check (timing_grade in ('A','B','C','D','F')),
  momentum_tercile    smallint check (momentum_tercile in (1,2,3)),
  setup_tag           text check (setup_tag in ('LEADER','WATCH','SPECULATIVE','AVOID','NEUTRAL')),
  confidence          text not null check (confidence in ('high','medium','low')),
  size_bucket         text check (size_bucket in ('small','mid','large')),
  score_breakdown     jsonb not null,
  primary key (run_id, asset_id)
);

-- Phase 4 (2026-09-23). One row per backtest execution. Inserted with its
-- prediction and status 'running' BEFORE any test runs, then updated with
-- results — so the recorded prediction provably predates the results
-- (created_at < finished_at). A candidate factor's evidence_ref points here
-- ("screener_backtest_runs:<id>"). The backtest scores with the production
-- code (config_version_id + code_commit identify exactly what ran).
create table cryptoport.screener_backtest_runs (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text not null default 'running' check (status in ('running','ok','error')),
  config_version_id  uuid not null references cryptoport.screener_scoring_config_versions(id),
  code_commit        text not null,
  prediction         text not null,
  params             jsonb not null,
  coverage           jsonb,
  results            jsonb,
  independent_check  jsonb,
  notes              text
);

-- Duplicate guard for the live path (the backfilled path has its own,
-- above): one live row per asset per run.
create unique index screener_asset_snapshots_live_run_asset_uidx
  on cryptoport.screener_asset_snapshots (run_id, asset_id)
  where not is_backfilled;

alter table cryptoport.screener_assets enable row level security;
alter table cryptoport.screener_runs enable row level security;
alter table cryptoport.screener_asset_snapshots enable row level security;
alter table cryptoport.screener_field_conflicts enable row level security;
alter table cryptoport.screener_unmatched enable row level security;
alter table cryptoport.screener_scoring_config_versions enable row level security;
alter table cryptoport.screener_regime_snapshots enable row level security;
alter table cryptoport.screener_asset_metrics enable row level security;
alter table cryptoport.screener_asset_scores enable row level security;
alter table cryptoport.screener_backtest_runs enable row level security;

-- Legacy, dropped in step B:
--   screener_asset_snapshots.provenance jsonb not null default '{}'::jsonb
--   create table cryptoport.screener_unmatched_log (
--     id uuid primary key default gen_random_uuid(),
--     run_id uuid references cryptoport.screener_runs(id) on delete set null,
--     kind text not null, identifier text not null, reason text,
--     created_at timestamptz not null default now());

-- signals_load_log (2026-09-24 measurement) dropped 2026-09-26 after the
-- candle-cache decision (docs/DECISIONS.md).

-- Cosmos multi-chain wallet sync (src/lib/adapters/cosmosMulti.ts): replaces
-- one wallet's Cosmos rows atomically. Rows are source 'auto_cosmos' and
-- carry their CoinGecko id, so they're priced only by that id (valuation.ts)
-- and re-priced by Refresh prices. Also clears the wallet's old 'auto' rows
-- (the native-ATOM-only row from before this feature).
-- v2 (2026-09-24): also stores protocol/protocol_url/protocol_section, for
-- the per-chain staking rows ("Staked" / "Staking rewards" / "Unbonding").
create or replace function cryptoport.sync_cosmos_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source in ('auto', 'auto_cosmos');

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, coingecko_id, display_label,
     protocol, protocol_url, protocol_section)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_cosmos',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'coingecko_id',
    h->>'display_label',
    h->>'protocol',
    h->>'protocol_url',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

grant execute on function cryptoport.sync_cosmos_holdings(uuid, jsonb, text) to authenticated;

-- Liquid staking tokens (2026-09-24): every member of CoinGecko's liquid
-- staking categories, refreshed weekly by the snapshot cron and by "Refresh
-- token list" (adapters/liquidStakingRegistry.ts). Shared reference data,
-- like token_registry: service_role only.
create table cryptoport.liquid_staking_tokens (
  coingecko_id text primary key,
  symbol       text not null,
  base_symbol  text,
  categories   text[] not null,
  updated_at   timestamptz not null default now()
);
alter table cryptoport.liquid_staking_tokens enable row level security;
grant all on cryptoport.liquid_staking_tokens to service_role;

-- Sync-time CoinGecko cache (2026-09-25): native coin prices/logos keyed by
-- CoinGecko id, and a short-lived contract price on token_registry, so a
-- Sync all prices each chain about once instead of once per wallet
-- (lib/priceCache.ts, adapters/coinCache.ts).
create table cryptoport.coin_cache (
  coingecko_id text primary key,
  usd          numeric,
  usd_at       timestamptz,
  image_url    text,
  updated_at   timestamptz not null default now()
);
alter table cryptoport.coin_cache enable row level security;
grant all on cryptoport.coin_cache to service_role;
alter table cryptoport.token_registry add column if not exists price_usd numeric;
alter table cryptoport.token_registry add column if not exists price_at timestamptz;

-- Pricing phase 1 (docs/pricing/PLAN.md), 2026-09-25: one price per asset,
-- built alongside today's price stores (nothing reads these yet).

-- One row per asset: a CoinGecko coin id, or a namespaced long-tail key
-- ('jup:<mint>', 'hl:<token>', 'coinbase:<ticker>'). base_key = the coin a
-- bridged/wrapped/staked variant combines with in display only.
create table if not exists cryptoport.assets (
  price_key  text primary key,
  symbol     text,
  name       text,
  image_url  text,
  kind       text,
  base_key   text,
  updated_at timestamptz not null default now()
);
alter table cryptoport.assets enable row level security;
grant all on cryptoport.assets to service_role;

-- chain + contract (address / mint / Sui type / Cosmos denom / 'native') ->
-- the asset it is. mapping_source says how the mapping was made.
create table if not exists cryptoport.asset_contracts (
  chain          text not null,
  contract       text not null,
  price_key      text not null,
  mapping_source text not null,
  updated_at     timestamptz not null default now(),
  primary key (chain, contract)
);
alter table cryptoport.asset_contracts enable row level security;
grant all on cryptoport.asset_contracts to service_role;
create index if not exists asset_contracts_price_key_idx on cryptoport.asset_contracts (price_key);

-- An exchange's own ticker -> asset, per exchange.
create table if not exists cryptoport.exchange_assets (
  exchange       text not null,
  ticker         text not null,
  price_key      text not null,
  mapping_source text not null,
  updated_at     timestamptz not null default now(),
  primary key (exchange, ticker)
);
alter table cryptoport.exchange_assets enable row level security;
grant all on cryptoport.exchange_assets to service_role;

-- The one price per asset. usd is the last price a source reported and is
-- never overwritten with null: a source omitting a key sets missing_since.
create table if not exists cryptoport.asset_prices (
  price_key       text primary key,
  usd             numeric,
  change_1h       numeric,
  change_24h      numeric,
  change_7d       numeric,
  change_30d      numeric,
  market_cap      numeric,
  source          text,
  updated_at      timestamptz,
  last_attempt_at timestamptz,
  missing_since   timestamptz,
  last_error      text
);
alter table cryptoport.asset_prices enable row level security;
grant all on cryptoport.asset_prices to service_role;

-- One row per pricing pass: what was asked, what came back, what it cost.
create table if not exists cryptoport.pricing_runs (
  id          bigint generated always as identity primary key,
  trigger     text not null,
  started_at  timestamptz not null default now(),
  duration_ms integer,
  requested   integer,
  returned    integer,
  missing     jsonb,
  calls       jsonb,
  error       text
);
alter table cryptoport.pricing_runs enable row level security;
grant all on cryptoport.pricing_runs to service_role;

alter table cryptoport.holdings add column if not exists price_key text;
create index if not exists holdings_price_key_idx on cryptoport.holdings (price_key);

-- Every sync function lists its insert columns, so each gains price_key.

create or replace function cryptoport.sync_auto_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings
    (price_key, wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    h->>'price_key',
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_defi_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_defi';

  insert into cryptoport.holdings
    (price_key, wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section, pool_contract)
  select
    h->>'price_key',
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_defi',
    h->>'contract',
    coalesce(h->>'category', 'defi'),
    h->>'chain',
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section',
    h->>'pool_contract'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set defi_synced_at = now(), defi_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_exchange_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto_exchange';

  insert into cryptoport.holdings
    (price_key, wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    h->>'price_key',
    p_wallet_id, h->>'ticker', (h->>'qty')::numeric, (h->>'usd_override')::numeric,
    'auto_exchange', h->>'contract', coalesce(h->>'category', 'token'), h->>'chain',
    h->>'icon_url', h->>'protocol', h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set exchange_synced_at = now(), exchange_sync_status = p_status
  where id = p_wallet_id;
end;
$$;

create or replace function cryptoport.sync_cosmos_holdings(
  p_wallet_id uuid,
  p_holdings jsonb,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to sync wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source in ('auto', 'auto_cosmos');

  insert into cryptoport.holdings
    (price_key, wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, coingecko_id, display_label,
     protocol, protocol_url, protocol_section)
  select
    h->>'price_key',
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto_cosmos',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url',
    h->>'coingecko_id',
    h->>'display_label',
    h->>'protocol',
    h->>'protocol_url',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

-- Pricing phase 3c (2026-09-25): each asset's daily close, written by the
-- daily snapshot from asset_prices (recordDailyCloses). Analytics' price
-- history for every asset, and the only one for jup:/hl:/coinbase: keys.
create table if not exists cryptoport.asset_price_daily (
  price_key text not null,
  day       date not null,
  usd       numeric not null,
  primary key (price_key, day)
);
alter table cryptoport.asset_price_daily enable row level security;
grant all on cryptoport.asset_price_daily to service_role;
grant select on cryptoport.asset_price_daily to authenticated;
create policy "asset_price_daily: readable by all signed-in users"
  on cryptoport.asset_price_daily for select to authenticated using (true);

-- Liquid staking / vault receipts counted once (2026-09-25, receiptDedupe.ts):
-- the 24h trading volume decides whether a receipt token is tradable, and a
-- DeFi row's pool contract links it to the wallet's copy of that token.
-- sync_defi_holdings above writes pool_contract.
alter table cryptoport.asset_prices add column if not exists volume_24h numeric;
alter table cryptoport.holdings add column if not exists pool_contract text;

-- Wallet balance discovery (docs/sync/PLAN.md, phase 2).

-- One row per wallet sync: how each chain's tokens were found and read, so
-- speed and API use are measured, not claimed (pricing_runs precedent).
create table if not exists cryptoport.sync_runs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  wallet_id   uuid not null references cryptoport.wallets(id) on delete cascade,
  started_at  timestamptz not null default now(),
  duration_ms integer,
  -- per chain: {chain, source, discovery_ms, pages, discovered, read, counted,
  -- receipt, unrecognized, calls, fallback}
  chains      jsonb not null default '[]'::jsonb
);
create index if not exists sync_runs_wallet_started on cryptoport.sync_runs (wallet_id, started_at desc);
alter table cryptoport.sync_runs enable row level security;
grant all on cryptoport.sync_runs to service_role;
grant select, insert on cryptoport.sync_runs to authenticated;
create policy "sync_runs: owner only" on cryptoport.sync_runs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Tokens a wallet holds that aren't counted (no CoinGecko price, not a known
-- receipt): listed per wallet as "Unrecognized tokens", never in totals, never
-- silently dropped. Rows at zero balance for two syncs are pruned.
create table if not exists cryptoport.wallet_discovered_tokens (
  user_id          uuid not null references auth.users(id) on delete cascade default auth.uid(),
  wallet_id        uuid not null references cryptoport.wallets(id) on delete cascade,
  chain            text not null,
  contract         text not null,
  symbol           text,
  decimals         integer,
  status           text not null default 'unrecognized',
  source           text not null,
  last_balance_raw text,
  zero_syncs       integer not null default 0,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  primary key (wallet_id, chain, contract)
);
alter table cryptoport.wallet_discovered_tokens enable row level security;
grant all on cryptoport.wallet_discovered_tokens to service_role;
grant select, insert, update, delete on cryptoport.wallet_discovered_tokens to authenticated;
create policy "wallet_discovered_tokens: owner only" on cryptoport.wallet_discovered_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Shared completed-candle cache for /signals (Hyperliquid candleSnapshot).
-- One row per coin + timeframe; completed candles packed as float64 binary
-- (t, o, h, l, c, n per candle, 48 bytes each). Rows unused for 14 days are
-- deleted by the daily snapshot cron. Server-only (service role): no
-- per-user data, no policies.
create table if not exists cryptoport.hl_candle_cache (
  coin            text not null,
  tf              text not null,          -- "1H" | "4H" | "1D"
  bar_seconds     integer not null,
  cover_from_sec  bigint not null,        -- window start the entry covers
  fetched_at_sec  bigint not null,
  candles         bytea not null,         -- completed candles, ascending
  forming         jsonb,                  -- the candle forming at fetch time
  last_used_at    timestamptz not null default now(),
  primary key (coin, tf)
);
create index if not exists hl_candle_cache_last_used on cryptoport.hl_candle_cache (last_used_at);
alter table cryptoport.hl_candle_cache enable row level security;
grant all on cryptoport.hl_candle_cache to service_role;

-- "Refresh positions" (Dashboard): replaces ONE venue's auto rows for one
-- wallet (e.g. its Hyperliquid account: positions, cash and margin together)
-- in one transaction, without touching the wallet's other rows or its
-- last_refresh_at (the rest of the wallet wasn't re-read). Same columns and
-- owner check as sync_auto_holdings.
create or replace function cryptoport.replace_venue_holdings(
  p_wallet_id uuid,
  p_chain text,
  p_holdings jsonb
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to refresh wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto' and chain = p_chain;

  insert into cryptoport.holdings
    (price_key, wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    h->>'price_key',
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    p_chain,
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;
end;
$$;
grant execute on function cryptoport.replace_venue_holdings(uuid, text, jsonb) to authenticated;

-- A symbol CoinGecko has no logo for is remembered (image_url null, re-checked
-- after 30 days — coingecko.ts resolveTickerIcons) instead of searched again
-- on every sync.
alter table cryptoport.ticker_icons alter column image_url drop not null;

-- v2 (2026-09-26): optional p_protocol narrows the replace to one protocol on
-- a shared chain (Jupiter Perps / Jupiter Prediction within 'solana-defi').
-- The 3-argument version is dropped first: an extra argument makes a second
-- function, and calls would be ambiguous.
drop function if exists cryptoport.replace_venue_holdings(uuid, text, jsonb);

-- "Refresh positions" (Dashboard): replaces ONE venue's auto rows for one
-- wallet (e.g. its Hyperliquid account: positions, cash and margin together)
-- in one transaction, without touching the wallet's other rows or its
-- last_refresh_at (the rest of the wallet wasn't re-read). Same columns and
-- owner check as sync_auto_holdings.
create or replace function cryptoport.replace_venue_holdings(
  p_wallet_id uuid,
  p_chain text,
  p_holdings jsonb,
  p_protocol text default null
)
returns void
language plpgsql
security definer
set search_path = cryptoport
as $$
begin
  if not exists (
    select 1 from cryptoport.wallets where id = p_wallet_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized to refresh wallet %', p_wallet_id;
  end if;

  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto' and chain = p_chain
    and (p_protocol is null or protocol = p_protocol);

  insert into cryptoport.holdings
    (price_key, wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url, protocol, protocol_url,
     position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd,
     position_pnl_percent, display_label, protocol_section)
  select
    h->>'price_key',
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    p_chain,
    h->>'icon_url',
    h->>'protocol',
    h->>'protocol_url',
    h->>'position_side',
    (h->>'position_leverage')::numeric,
    (h->>'position_entry_price')::numeric,
    (h->>'position_liquidation_price')::numeric,
    (h->>'position_pnl_usd')::numeric,
    (h->>'position_pnl_percent')::numeric,
    h->>'display_label',
    h->>'protocol_section'
  from jsonb_array_elements(p_holdings) as h;
end;
$$;
grant execute on function cryptoport.replace_venue_holdings(uuid, text, jsonb, text) to authenticated;
