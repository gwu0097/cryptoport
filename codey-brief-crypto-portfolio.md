# Build brief: crypto portfolio tracker — foundation

## Scope

**Three wallets. Two adapters. Nothing else.**

This is the foundation slice. It deliberately excludes most of what the finished
app will do, so that when something breaks there are very few places to look.
Do not add chains, wallets, or views beyond what is listed here — there is an
appendix of things explicitly *not* in scope.

## What this is

A private, single-user crypto portfolio tracker. Wallets list with a value per
wallet; drill into a wallet to see its tokens. CoinStats in spirit, a fraction of
the scope.

Three questions it must answer: what do I own, which wallet is it in, what is it
worth right now.

## Stack

Next.js (App Router) + TypeScript on Vercel, Supabase Postgres. Same shape as the
owner's `csp-screener`. Single user, no multi-tenancy.

**The repo must be private.** It will hold real wallet addresses; published
together they expose the owner's on-chain net worth permanently, and git history
makes that irreversible.

---

## The three wallets

| Wallet | Chain | Mode | Address |
|---|---|---|---|
| Biz NFT | ETH | `auto` | `0x1a65aB3f75F802ab7829f558d8F680c58a55251d` |
| Ledger BTC - Biz | BTC | `manual` (single token) | `bc1qj4uu9v5qkhfra9hah4jwddv68qhnhrllcgggkd` |
| Phantom Wallet | SOL | `auto` | `Cxypnyeyta1B5CfcbhCjUAp7erJdiSB7z1xA8TrvS8QE` |

Ledger BTC - Biz holds **1.5291763 BTC**, entered by hand.

The BTC address is never queried — it is stored for reference only. There is no
BTC adapter in this phase and none is needed: the quantity is typed and the price
is looked up, which is the whole point of manual mode.

---

## Core model

The central idea: **a wallet's value is the sum of its holdings, and every
holding records where it came from.** There is no separate "manual wallet" and
"auto wallet" code path.

```sql
create table wallets (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text,
  chain         text not null,            -- 'BTC' | 'ETH' | 'SOL'
  mode          text not null,            -- 'manual' | 'auto'
  account       text default 'personal',  -- 'personal' | 'biz'
  notes         text,
  active        boolean default true,
  last_refresh_at timestamptz,
  last_refresh_status text,
  created_at    timestamptz default now()
);

create table holdings (
  id           uuid primary key default gen_random_uuid(),
  wallet_id    uuid not null references wallets(id) on delete cascade,
  ticker       text not null,
  qty          numeric,
  usd_override numeric,       -- manual_usd only; bypasses pricing entirely
  source       text not null, -- 'manual_qty' | 'manual_usd' | 'auto'
  contract     text,          -- contract / mint address, for auto rows
  updated_at   timestamptz default now()
);

create table prices (
  ticker     text primary key,
  usd        numeric,
  source     text,            -- 'coinbase' | 'jupiter'
  updated_at timestamptz
);
```

`tokens`, `snapshots`, categories and targets are **later phases**. Do not create
them yet.

### The rule that must never be broken

**The refresh job may only touch rows where `source = 'auto'`.** Manual rows are
untouchable — enforced by the query, not by convention. The Google Sheet this
replaces kept overwriting hand-entered values, and that is the single biggest
reason this rebuild exists.

Write this as a test: refresh twice, assert the BTC holding is byte-identical.

### Valuation

```
holding value = usd_override           when source = 'manual_usd'
              = qty * prices.usd       otherwise
              = UNPRICED               when no price exists
```

**Never coerce a missing price to zero, and never let a quantity stand in for a
dollar value.** The old sheet reported a $3.25M portfolio because unpriced tokens
had their quantity summed as if it were dollars. Unpriced holdings must show as
"unpriced" in the UI and be excluded from totals with the excluded count visible.

---

## Modes

**`manual`** — holdings entered by hand. For a single-token wallet, picking the
chain pre-fills the ticker (chain `BTC` → ticker `BTC`) so only an amount is
typed. Quantity is static; **value updates on every price refresh.** That is the
feature, not a shortcut.

**`auto`** — an adapter fetches holdings on refresh, writing `source='auto'` rows
and replacing prior auto rows for that wallet only. List every token worth **more
than $5** with quantity and value, plus a count and total of what was filtered.

---

## Adapter 1 — EVM (for Biz NFT)

Verified live. Free, no API key.

```
GET https://api.rabby.io/v1/user/total_balance?id=<address>
```

Returns `total_usd_value` and a `chain_list` spanning ~72 EVM chains. This is
DeBank's backend — undocumented and unsupported, but the only free source with
this coverage.

**It rate-limits.** Six of twelve wallets returned HTTP 429 when called ~250ms
apart. Crawl it: ~2.5s between calls, exponential backoff on 429/503, 3 attempts.
This is the only provider that punished us.

Also call **Hyperliquid** for every EVM address — Rabby does not cover it, and it
was worth **$12,335** on this exact wallet:

```
POST https://api.hyperliquid.xyz/info
  {"type":"clearinghouseState","user":"<address>"}      -> marginSummary.accountValue
  {"type":"spotClearinghouseState","user":"<address>"}  -> balances[]
```

Spot: count USDC / USDT0 / USDE at $1. Other spot tokens need a price lookup or
must be reported unpriced — do not guess.

### Known open question — resolve this early

Measurements taken during design, on this wallet:

| Source | Value |
|---|---|
| Rabby `total_usd_value` | $35,782 |
| Hyperliquid perps | $4,339 |
| Hyperliquid spot USDC | $10,769 |
| **Naive sum** | **$50,890** |
| **DeBank's own UI, same day** | **$49,278** |

The sum overshoots by ~$1,600. That is either price drift between reads, or
partial double-counting between Rabby and Hyperliquid. **Determine which before
trusting the total.** DeBank's UI breakdown for this wallet was: Wallet $32,550,
Hyperliquid $12,335, Pequod $1,545, plus smaller protocol positions.

---

## Adapter 2 — Solana (for Phantom Wallet)

Verified live. Free, no API key.

```
GET https://lite-api.jup.ag/ultra/v1/balances/<address>
GET https://lite-api.jup.ag/price/v3?ids=<comma-separated mints, ~90 per call>
```

Balances come keyed by mint, with native SOL under the literal key `SOL` — map it
to mint `So11111111111111111111111111111111111111112`.

The price response includes a **`liquidity`** field. Use it as the spam filter,
alongside the $5 floor. Real holdings sit at $100M+ liquidity; a test wallet held
$324 of a token with $17,019 liquidity, the classic pump-and-dump airdrop
profile. Tokens Jupiter cannot price at all are almost always worthless.

Liquid staking tokens (mSOL, jupSOL, vSOL) are ordinary SPL tokens and come
through automatically.

### Expect this wallet to under-report, and do not treat it as a bug

Phantom Wallet is known to hold **Meteora and DLMM liquidity-pool positions**.
Those are not token balances and Jupiter's balance call will not see them. The
auto value will therefore be lower than the owner believes is in the wallet.

This is a real, understood limitation of the approach — the same class of gap as
NFTs. Surface it honestly rather than papering over it; a per-wallet note field
is enough for now.

A second Solana wallet was measured during design as a sanity check on the
adapter itself: 88.55 SOL plus mSOL, jupSOL and bSOL, totalling ~$12,664 from 31
tokens of which 17 priced and 14 did not. Use it if you want a second fixture.

---

## Prices

```
GET https://api.coinbase.com/v2/prices/<TICKER>-USD/spot
```

Free, no key. Covers BTC and ETH. Jupiter covers Solana-native tokens.

**Prices are driven by holdings, not by adapters.** Every distinct ticker across
all holdings needs a price — including BTC, which no adapter ever pulls but which
must be priced for the manual wallet to work at all. Cache per run; persist to
`prices`.

---

## Refresh job

- **Upsert, never wipe.** A wallet that errors keeps its previous values and
  previous timestamp. A partially completed run loses nothing.
- Skip wallets refreshed within the last 45 minutes, so re-runs are cheap and
  repair the previous run's failures.
- Record per-wallet status and timestamp; show staleness in the UI.
- A manual "Refresh" button is enough for this phase. Vercel Cron comes later.

---

## UI — two pages

**Wallets list** (home): name, chain, account, mode, current value, staleness.
Grand total on top, with unpriced holdings called out separately rather than
folded in.

**Wallet detail**: holdings — ticker, qty, price, value, source badge
(auto / manual). Add, edit and delete manual holdings here. For an auto wallet,
show tokens over $5 plus "N tokens under $5 hidden ($X)".

Plus an **Add wallet** form: name, address, chain, mode.

---

## Definition of done

With exactly these three wallets:

1. Ledger BTC - Biz shows a value from a typed 1.5291763 BTC and a live price,
   and that value moves when the price moves with nobody touching the quantity.
2. Biz NFT auto-populates across multiple chains, and its value includes
   Hyperliquid.
3. Phantom Wallet auto-populates, lists tokens over $5, and reports how many were
   filtered out.
4. Running refresh twice leaves the BTC holding byte-identical. **Tested.**
5. A wallet whose fetch fails keeps its previous value and previous timestamp.
6. Any unpriced holding renders as "unpriced" and is excluded from the total,
   with the exclusion visible.

---

## Appendix — explicitly NOT in this phase

Do not build these. They are listed so they are not accidentally started, and so
the schema is not prematurely generalised for them.

- Adapters for SEI, Cosmos, Cardano — all researched and solved, but each has a
  non-obvious address derivation and belongs in its own phase. Ask before starting.
- Adapters for ICP, SUI, XRP, TON, NEAR, NEO, TAO, FIL, BCH, APT.
- CEX balances (MEXC, Bitunix) — need per-exchange API keys.
- NFT valuation, DeFi/LP position valuation.
- Importing the other ~45 wallets from the existing sheet.
- By-token rollup across wallets, allocation targets, history charts, snapshots.
- Vercel Cron.

## One note on the addresses above

They were transcribed from the owner's spreadsheet. Eyeball them once against the
source before the first run. A mistyped EVM address does not error — it silently
returns a different wallet's balance or zero.
