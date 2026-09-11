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
  ticker     text primary key,
  usd        numeric,
  source     text,            -- 'coinbase' | 'jupiter'
  updated_at timestamptz
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

-- Atomic delete+insert for one wallet's auto-sourced holdings, called by
-- syncWalletHoldings(). Doing this as a single PL/pgSQL function call makes
-- it one transaction: if the insert fails partway (bad row shape, etc.) the
-- delete rolls back too, so a failed sync never leaves a wallet with zero
-- holdings. The `source = 'auto'` predicate (never just wallet_id) is what
-- keeps this from ever touching a manually-entered holding in the same
-- wallet. Also stamps the wallet's refresh time/status in the same
-- transaction as the holdings themselves.
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
  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings (wallet_id, ticker, qty, usd_override, source, contract, category)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token')
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

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
  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings (wallet_id, ticker, qty, usd_override, source, contract, category, chain)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

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

-- Snapshotted onto the holding at sync time, same as usd_override — avoids
-- a join at render time and means a holding's icon survives even if its
-- token_registry row's cached image_url is later cleared/changed.
alter table cryptoport.holdings
  add column icon_url text;

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
  delete from cryptoport.holdings
  where wallet_id = p_wallet_id and source = 'auto';

  insert into cryptoport.holdings
    (wallet_id, ticker, qty, usd_override, source, contract, category, chain, icon_url)
  select
    p_wallet_id,
    h->>'ticker',
    (h->>'qty')::numeric,
    (h->>'usd_override')::numeric,
    'auto',
    h->>'contract',
    coalesce(h->>'category', 'token'),
    h->>'chain',
    h->>'icon_url'
  from jsonb_array_elements(p_holdings) as h;

  update cryptoport.wallets
  set last_refresh_at = now(), last_refresh_status = p_status
  where id = p_wallet_id;
end;
$$;

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
  constraint price_refresh_state_singleton check (id = 1)
);

alter table cryptoport.price_refresh_state enable row level security;
grant all on cryptoport.price_refresh_state to service_role;

insert into cryptoport.price_refresh_state (id, refreshed_at, status) values (1, null, null);

-- DeFi position breakdown (which protocol a position lives in, and a link
-- to it — DeBank/Rabby-style) — see adapters/jupiterPositions.ts, the first
-- adapter to populate these. Null for every plain token holding.
alter table cryptoport.holdings
  add column protocol text,
  add column protocol_url text;

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
grant select, insert, update, delete on cryptoport.wallets to authenticated;
grant select, insert, update, delete on cryptoport.holdings to authenticated;
grant select, insert, update, delete on cryptoport.tags to authenticated;

-- sync_auto_holdings is security definer (runs with elevated privileges),
-- so RLS does NOT protect it internally — without this explicit check, any
-- authenticated user could call the RPC with someone else's wallet_id and
-- overwrite their holdings. Ownership is checked up front instead.
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
