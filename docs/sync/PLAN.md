# Wallet balance discovery — plan

Status: revised after Fable's review, 2026-09-25 — awaiting owner sign-off on
the two decisions below. No code yet.

## Goal

Find every legitimate token an EVM wallet holds on every chain it uses, fast,
within free API tiers, and keep syncs from getting slower as chains are added.

## Why (today)

`multicallEvm.ts` scans a fixed list of 38 chains; on each it reads
`balanceOf` for every token CoinGecko lists on that chain (`token_registry`).
Hit on 2026-09-25:

- **Tokens CoinGecko doesn't list are never found** (Taiko `aTkoWETH`, Blast
  Hyperlock `hUSDB` on Metamask Main) — discovery is limited by CoinGecko's
  list, not by what the wallet holds. (Found tokens CoinGecko lists but can't
  price are silently dropped today: `priceScans` `unpriced++; continue`.)
- **Every chain's full token list is scanned for every wallet**: a sync takes
  10–14 s, dominated by the big registries (eth, bsc, base, arb, polygon).
- **Chain coverage is hand-curated**, one verified entry at a time.

Residual gap no indexer closes: a token that reached the wallet with no
Transfer log to it (genesis/constructor allocations, non-standard mints).
Mitigated by re-reading last sync's tokens (D2) and by `wallet-vs-zerion.ts`.

## How the leading products do it

DeBank (whose API Rabby's portfolio uses) and Zerion run their own indexers —
every Transfer event on every supported chain, stored per address; a lookup is
a database read. DeBank exposes the chains an address has used and fetches
tokens only for those; Zerion classifies spam (`filter[trash]`). None scans a
token list with multicalls. We can't run an indexer across dozens of chains;
we can use indexers others run, on free tiers.

## Sources (verified live 2026-09-25)

| Source | Chains (of ours) | Finds unlisted tokens | Free budget (verify in phase 1) |
|---|---|---|---|
| Alchemy `alchemy_getTokenBalances` | 20: eth, base, arb, op, polygon, avax, bsc, linea, scroll, blast, zksync, gnosis, celo, zora, berachain, zetachain, soneium, ronin, unichain, robinhood | yes (hUSDB) | 30M CU/month; ~20 CU/call |
| Etherscan v2 `tokentx` (free) | mantle, taiko, opbnb, fraxtal, sei, sonic | yes (aTkoWETH) | 100k calls/day, ~3/s; 10k-record window per query |
| Blockscout `/api/v2/addresses/{a}/tokens?type=ERC-20` | mode, metis, pulsechain, aurora, dbk, chiliz, merlin | yes, with symbol/decimals | unstated — assume burst limits |

Alchemy's cheap per-chain call returned the same tokens as its Portfolio API on
every chain compared. Alchemy "not enabled for this app" (Taiko, Merlin,
Chiliz, Polygon zkEVM) — not offered in the owner's dashboard, so unavailable;
"EAPIs not enabled on network" — no token API there. The per-chain discovery
source is config checked live, never derived from `adapters/alchemy.ts`
`ALCHEMY_HOSTS` (that map is the transaction path's, and wrong — see below).

## Design

**D1. Discovery, per chain:** the chain's configured source
(`evmChains.ts` `discovery: "alchemy" | "etherscan" | "blockscout" | "registry"`)
returns token contract addresses (lowercased, de-duplicated). Every call goes
through `fetchWithRetry`, capped with `mapWithConcurrency` (start at 5 per
wallet; a Sync all runs 2 EVM wallets at once — `LANE_CONCURRENCY`).

**D2. Balances stay ours.** One Multicall3 pass per chain reads `balanceOf` for
the union, keyed by lowercase contract, of (a) discovered contracts and
(b) contracts of this wallet's previous `source='auto'`, `category='token'`
rows on that chain (never `auto_defi` rows — those are Zerion coin contracts);
plus the native balance on every chain, as today. (b) means the first run on
each wallet re-reads every token the registry scan found, so switching sources
can't lose one an indexer misses. Our chain reads remain the source of truth for
quantities; valuation is unchanged (price_key → asset_prices).
- **Native guard:** drop any contract whose price_key is the chain's
  `nativeCoingeckoId` (CELO's ERC-20, Mantle's `0xdead…` — the rule
  `fetchChainHoldings` already applies), so the native coin is counted once.
- **Metadata:** a discovered contract not in `token_registry` gets
  `symbol()`/`decimals()` from one multicall (bytes32-symbol fallback) or the
  source's own metadata. **Never written to `token_registry`** — that table is
  CoinGecko's map; the registry path reads only CoinGecko-listed rows
  (`getRegisteredTokens` gains a `coingecko_id is not null` guard).

**D3. Classification (one pure, tested `src/lib/*.ts` function):** a token with
a non-zero balance is
- **counted** — its price_key resolves and `asset_prices` has a usd (decided
  before rows are written; `TOKEN_USD_FLOOR` $0.01 still applies);
- **receipt** — see Decision 1;
- **unrecognized** — anything else: not in totals, never silently dropped (see
  Decision 2). A token that backs a DeFi position is handled by the existing
  receipt dedupe (the position counts).
A CoinGecko-listed token with a manipulated price passes "counted";
`asset_prices.volume_24h` ("listed, no market") flags it for review, and the
parked GeckoTerminal liquidity rule (BACKLOG) is the fuller answer.

**D4. Failure is per chain and all-or-nothing** (CLAUDE.md §4.3). Any page
failure, "not enabled"/"unsupported", 429 after retries or quota error marks
that chain's discovery failed → fall back to (b) ∪ the registry scan for that
chain; the status names the source. A misconfigured source is surfaced once
(status + coverage report), never `[]`. Alchemy's monthly quota running out
degrades every Alchemy chain to today's registry scan with one status line.

**D5. Measured, not claimed:** a `sync_runs` log (the `pricing_runs`
precedent): per wallet sync, per chain — source, discovery ms, pages, tokens
discovered/read/counted/receipt/unrecognized, calls, fallback reason. It is
what gates phase 3 and makes a heavy user's API use visible.

Dropped from the first draft (review): the RPC activity probe — it can skip a
chain forever when a wallet received a token there without ever sending (native
0, nonce 0), and the speed gain comes from indexer discovery on the big chains
anyway. Revisit only if a generated catalog adds many registry chains.

## Decisions for the owner

1. **Receipt tokens CoinGecko doesn't list** (aTkoWETH, hUSDB-type): either
   (a) **unrecognized** — listed, not in totals; or (b) **valued as their
   underlying** — stored as `qty = underlying amount` (convertToAssets /
   aToken 1:1 / cToken rate, `receiptTokens.ts`), priced by the underlying's
   price_key, labeled "aTkoWETH (as WETH)". (b) is a new pricing rule (CLAUDE.md
   §4.2 and the pricing plan updated with it); quantities drift between syncs
   as yield accrues. **Recommended: (b).**
2. **Where unrecognized tokens live:** a per-wallet table
   (`wallet_discovered_tokens`: wallet, chain, contract, symbol, decimals,
   status, source, first/last seen, last balance; RLS; zero-balance rows pruned
   after two syncs; also holds the Etherscan block cursor), shown as a collapsed
   "Unrecognized tokens" group per wallet with the caption "N unrecognized
   tokens not included". Symbols are shown as plain escaped text (spam symbols
   carry URLs). A user who knows what one is picks its coin (the existing
   `asset_contracts` override / coin picker) and it's counted from then on.
   `holdings` keeps meaning "things that count". **Recommended.**

## Phases (each its own commit; owner sign-off between)

1. **Prototype + measure (read-only diag, no behaviour change)** — for BizNFT,
   a light wallet, the spam-heavy wallet, Metamask Main and one public
   non-owner address (an airdrop farmer): per chain, the set difference both
   ways (registry scan vs Alchemy), each with contract/symbol/USD; wall time per
   stage vs today; Alchemy calls/pages (CU from the dashboard); every error
   class and its fallback; two runs agree. **Gate:** no token ≥ $0.01 the
   registry scan finds that Alchemy misses (or each explained and covered by
   D2's (b)); Celo/Mantle native counted once; receipt dedupe unchanged;
   faster; budget held under a real Sync all.
2. **DDL** — `sync_runs`, and `wallet_discovered_tokens` if Decision 2 stands
   (SQL handed over; hold branch until run).
3. **Alchemy discovery live on its 20 chains**; every other chain unchanged
   (registry scan). Gate: `portfolio-totals.ts` before/after per wallet — only
   increases from newly found tokens, each named; `wallet-vs-zerion.ts` gaps
   shrink; the D5 log confirms speed and budget.
4. **Unrecognized tokens UI** + coverage-report entries (value on chains we
   don't scan; unrecognized counts).
5. **Etherscan / Blockscout discovery** for the chains where phase 1/3 show real
   misses (Taiko first: aTkoWETH). Etherscan needs `startblock` windowing past
   10k records and the stored cursor.
6. **Generated chain catalog** (chainlist + Multicall3 + CoinGecko platform +
   live checks) — only after discovery makes an extra chain cheap.

## Budget (to verify in phase 1)

~25+ Alchemy calls per full EVM wallet sync (a floor: spam-heavy chains page at
100 tokens). 100 users × 3 wallets × 4 syncs/day ≈ 36k syncs/month ≈ 18M CU of
30M at ~500 CU/sync. The sync runs in `after()` within `maxDuration = 300`; a
624-token wallet is a few multicall chunks per chain.

## Also found (separate fix)

`adapters/alchemy.ts` `ALCHEMY_HOSTS` routes transaction history for Mantle,
opBNB, Sei, Fraxtal, Mode, Metis and Cronos to Alchemy, which answers "EAPIs not
enabled", and the adapter turns errors into `[]` — their transaction history is
likely empty. Etherscan (free) or Blockscout cover them; an error must never
become `[]`.
