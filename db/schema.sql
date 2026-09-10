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
