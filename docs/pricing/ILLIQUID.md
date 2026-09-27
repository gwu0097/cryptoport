# Junk tokens: fake receipts and illiquid airdrops

Status: **done 2026-09-26** (part A `bfc058d`; part B: option 1, shown not counted, with a $1,000 minimum). Found while testing
Wallet Watch; it affects every portfolio total, the user's own included.

## What was found

Six real wallets tested (Wallet Watch phase 1). Two problems inflated totals:

1. **A fake receipt.** "Bera the Cub" (`0x0d9a…871c` on Berachain, symbol
   "BTC") was valued as 1,010,069 WBERA ($236K) in one wallet, 1,010,000 in
   another, 10,000 in a third — round airdrop amounts. It passed the Compound
   v3 check in `adapters/receiptTokens.ts` because that check only calls
   `baseToken()`, and the token answers it (meme launchpads commonly add
   it). On-chain it isn't a market: it holds 0 WBERA, and `asset()`,
   `totalAssets()`, `underlying()` all revert.
2. **Illiquid airdrops priced at face value.** A 10-billion-token WHITE
   airdrop "worth" $339,500 trades $710 a day with no market cap; KNCL $102K
   against $42 a day; MOODENG $125K (7% of its market cap). Nobody could sell
   these at the shown price. In the most airdropped wallet (Vitalik's) they
   were ~$925K of a $1.0M total.

Measured on every holding ≥ $1,000 across both users' portfolios and the
watched wallets (asset_prices `volume_24h`, `market_cap`):

| Rule | Flags | Wrongly flags |
|---|---|---|
| position > 1× 24h volume | WHITE, fake BTC, MOODENG, KNCL, MEH, KEL, ETHARDIO, Cupsey, AWETH | Cupsey (real, 2% of mcap), AWETH (an Aave receipt; CoinGecko has $0 volume) |
| position > 0.5× volume | the above + SPX ($4.8M, Murad) | SPX — a real whale position |
| **position > 1× 24h volume and (> 5% of market cap, or market cap unknown/0)** | WHITE, fake BTC, MOODENG, KNCL, MEH, KEL, ETHARDIO | none found |

The users' own portfolios: nothing flagged by the last rule (the closest is
stMATIC at 0.68× volume, not flagged).

## How others handle it

- **Zerion** and **DeBank** separate spam/suspicious tokens from the
  portfolio total (Zerion's "trash"; DeBank's hidden/suspicious tokens), from
  their own token lists and heuristics.
- **Arkham** counts everything at its price — which is why Murad reads $13.9M
  there including airdrops.
- Receipts: protocol integrations (DeBank, Zerion) value a vault/lending
  position through the protocol's own contracts, never through one function a
  token claims to implement.

We have no DEX-liquidity data; CoinGecko's 24h volume and market cap (already
in `asset_prices`, no new calls) are the available signal.

## Proposal

**Part A — receipts must prove they're receipts (bug fix, small).**
In `receiptTokens.ts`, each standard needs a second, standard-specific
answer before a token is valued as its underlying:
- Compound v3 (Comet): `baseTokenPriceFeed()` and `getUtilization()` must
  succeed, not just `baseToken()`.
- ERC-4626: `totalAssets()` must succeed and the holder's claim must not
  exceed it.
- Every kind: the claim must not exceed the underlying token's total supply.

Gate: the user's four real receipts (hUSDB, ironETH, aTkoWETH, AMETIS) still
read as before; "Bera the Cub" no longer does (it becomes an unrecognized
token). Unit tests for each rejection.

**Part B — illiquid holdings are shown but not counted (owner decision).**
A priced token holding is **illiquid** when its value is more than its
token's 24h trading volume *and* more than 5% of its market cap (or the
market cap is unknown). Illiquid holdings:
- stay listed, marked "Illiquid — not counted" with the reason on hover;
- are excluded from totals, like an unpriced holding, and named in the
  "not counted" note (unknown is never 0: we're not saying they're worth $0,
  we're saying the price shown can't be realized);
- produce no Wallet Watch movements.

Thresholds are named constants (`ILLIQUID_VOLUME_MULTIPLE = 1`,
`ILLIQUID_MCAP_SHARE = 0.05`). Only CoinGecko-priced coins have volume and
market cap; Jupiter/Hyperliquid/Coinbase-priced coins are never flagged
(their venue sets the price from its own trading).

Where it lives: a pure `liquidity.ts` (tested) used by `valuation.ts`'s
`valueHolding` — so Dashboard, Assets, Analytics, snapshots and Wallet
Watch all agree. Gate: `scripts/diag/portfolio-totals.ts save`/`compare`
before and after — the users' totals move only by the flagged rows (none
expected today); the watched wallets drop by exactly their flagged rows.

**Alternative for B:** flag but keep counting (Arkham's approach). Simpler,
but Wallet Watch totals and movements would keep reporting airdrops as
buys.

## Order

Part A first (a bug, no decision needed beyond this doc), then Part B once
the owner picks B or its alternative. Then Wallet Watch phase 2.

## Result (2026-09-26)

Both users' totals unchanged to the cent (nothing flagged). Watched wallets:
Vitalik $1,006,846 → $197,958 (WHITE, MOODENG, KNCL, the fake BTC and three
small airdrops not counted); Murad's `0x6B41…` $5.09M → $4.85M (only the
fake BTC); the other five unchanged. Added a $1,000 minimum
(`ILLIQUID_MIN_USD`) so small tokens aren't flagged as noise.
