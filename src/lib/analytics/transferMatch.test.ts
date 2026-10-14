import test from "node:test";
import assert from "node:assert/strict";
import { coinKey, matchDestinations, tickersToName, type DroppedCoin, type MatchInput, type MatchWallet, type TxLeg } from "./transferMatch.ts";
import { destinationText } from "./destinationText.ts";

// The owner's Metamask Main on 2026-10-07 (found by hand, 2026-10-14).
const MAIN = "w-main";
const LEDGER = "w-ledger";
const HL_CCTP = "0xa95d9c1f655341597c94393fddc30cf3c08e4fce";
const wallets: MatchWallet[] = [
  { id: MAIN, name: "Metamask Main", address: "0xEa7E000000000000000000000000000000000001", txSyncedAt: "2026-10-14T08:00:00.000Z" },
  { id: LEDGER, name: "Ledger ETH", address: "0x1Ed6000000000000000000000000000000000002", txSyncedAt: "2026-10-14T08:00:00.000Z" },
];
const since = new Map([
  [MAIN, "2026-10-07T06:00:04.512+00:00"],
  [LEDGER, "2026-10-07T06:00:04.512+00:00"],
]);
const PRICES: Record<string, number> = { USDC: 1, ETH: 4_480, ZK: 0.0118, SAND: 0.3, WEETH: 4_790 };
const priceOf = (t: string) => PRICES[t.toUpperCase()] ?? null;

const leg = (o: Partial<TxLeg> & Pick<TxLeg, "chain" | "txHash" | "occurredAt" | "direction" | "ticker" | "amount">): TxLeg => ({ walletId: MAIN, counterparty: null, ...o });
const ROUTER = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const ownerLegs: TxLeg[] = [
  // ZK bridged out on zkSync; USDC arrives on Arbitrum seconds later, another transaction.
  leg({ chain: "zksync", txHash: "0xzk", occurredAt: "2026-10-07T19:40:40Z", direction: "out", ticker: "ZK", amount: 29_000, counterparty: "0xbridge00000000000000000000000000000000aa" }),
  leg({ chain: "arb", txHash: "0xarrive", occurredAt: "2026-10-07T19:40:52Z", direction: "in", ticker: "USDC", amount: 342.18, counterparty: "0xsolver0000000000000000000000000000000bb" }),
  // SAND swapped for ETH in one transaction (both legs name the router).
  leg({ chain: "eth", txHash: "0xsand", occurredAt: "2026-10-07T18:02:11Z", direction: "out", ticker: "SAND", amount: 557.07, counterparty: ROUTER }),
  leg({ chain: "eth", txHash: "0xsand", occurredAt: "2026-10-07T18:02:11Z", direction: "in", ticker: "ETH", amount: 0.0168, counterparty: ROUTER }),
  // weETH swapped for USDC in one transaction.
  leg({ chain: "arb", txHash: "0xweeth", occurredAt: "2026-10-07T19:31:05Z", direction: "out", ticker: "weETH", amount: 0.1, counterparty: ROUTER }),
  leg({ chain: "arb", txHash: "0xweeth", occurredAt: "2026-10-07T19:31:05Z", direction: "in", ticker: "USDC", amount: 282.86, counterparty: ROUTER }),
  // Then 700 USDC deposited to Hyperliquid.
  leg({ chain: "arb", txHash: "0xhl", occurredAt: "2026-10-07T19:45:30Z", direction: "out", ticker: "USDC", amount: 700, counterparty: HL_CCTP }),
];
const coin = (key: string, symbol: string | null, drop: number, unitPrice: number | null, walletId = MAIN): DroppedCoin => ({ walletId, key, symbol, drop, unitPrice });
const ownerCoins = [coin("zksync", "ZK", 29_000, 0.0118), coin("the-sandbox", "SAND", 557.07, 0.3), coin("wrapped-eeth", "WEETH", 0.1, 4_790), coin("usd-coin", "USDC", 74.96, 1)];
const run = (o: Partial<MatchInput> = {}) => matchDestinations({ legs: ownerLegs, wallets, since, coins: ownerCoins, priceOf, ...o });
const lines = (r: ReturnType<typeof run>, key: string, ticker: string, walletId = MAIN) => (r.byCoin.get(coinKey(walletId, key)) ?? []).map((d) => destinationText(d, ticker));

test("the owner's Metamask Main: ZK → USDC on Arbitrum → Hyperliquid, SAND → ETH, weETH → USDC → Hyperliquid, USDC → Hyperliquid", () => {
  const r = run();
  assert.deepEqual(lines(r, "zksync", "zksync"), ["→ 342.18 USDC on Arbitrum → Hyperliquid"]);
  assert.deepEqual(lines(r, "the-sandbox", "the-sandbox"), ["→ 0.0168 ETH"]);
  assert.deepEqual(lines(r, "wrapped-eeth", "weETH"), ["→ 282.86 USDC → Hyperliquid"]);
  assert.deepEqual(lines(r, "usd-coin", "USDC"), ["→ Hyperliquid"]);
  assert.deepEqual(r.moves, []);
});

test("rule 1: a coin in from the same transaction is a trade, even though both legs name the router", () => {
  const d = run().byCoin.get(coinKey(MAIN, "the-sandbox"))!;
  assert.equal(d[0].kind, "trade");
  assert.deepEqual(d[0].kind === "trade" && d[0].into, [{ ticker: "ETH", amount: 0.0168, chain: "eth" }]);
});

test("rule 2: sent to another of the user's wallets is a move, listed once", () => {
  const legs = [leg({ chain: "eth", txHash: "0xmv", occurredAt: "2026-10-08T10:00:00Z", direction: "out", ticker: "ETH", amount: 0.5, counterparty: "0x1ed6000000000000000000000000000000000002" })];
  const r = run({ legs, coins: [coin("ethereum", "ETH", 0.5, 4_000)] });
  assert.deepEqual(lines(r, "ethereum", "ETH"), ["→ Ledger ETH"]);
  assert.deepEqual(r.moves, [{ fromWalletId: MAIN, fromWalletName: "Metamask Main", toWalletId: LEDGER, toWalletName: "Ledger ETH", ticker: "ETH", amount: 0.5, usd: 2_000 }]);
});

test("rule 3: an arrival over 10 minutes later, or more than 10% off in value, is not the other side of a swap", () => {
  const zkOut = ownerLegs[0];
  const at = (iso: string, amount = 342.18) => [zkOut, leg({ chain: "arb", txHash: "0xarrive", occurredAt: iso, direction: "in", ticker: "USDC", amount })];
  const zk = (legs: TxLeg[]) => lines(run({ legs, coins: [ownerCoins[0]] }), "zksync", "zksync");
  assert.deepEqual(zk(at("2026-10-07T19:50:39Z")), ["→ 342.18 USDC on Arbitrum"], "9 min 59 s after");
  assert.deepEqual(zk(at("2026-10-07T19:50:41Z")), ["sent to 0xbr…00aa"], "10 min 1 s after");
  assert.deepEqual(zk(at("2026-10-07T19:40:00Z")), ["→ 342.18 USDC on Arbitrum"], "40 s before: two chains' clocks");
  assert.deepEqual(zk(at("2026-10-07T19:39:30Z")), ["sent to 0xbr…00aa"], "70 s before");
  assert.deepEqual(zk(at("2026-10-07T19:41:00Z", 310)), ["→ 310 USDC on Arbitrum"], "9.4% under");
  assert.deepEqual(zk(at("2026-10-07T19:41:00Z", 300)), ["sent to 0xbr…00aa"], "12.3% under");
  assert.deepEqual(zk(at("2026-10-07T19:41:00Z", 380)), ["sent to 0xbr…00aa"], "11% over");
});

test("rule 3: no match when either side can't be valued", () => {
  const legs = [ownerLegs[0], ownerLegs[1]];
  assert.deepEqual(lines(run({ legs, coins: [coin("zksync", "ZK", 29_000, null)] }), "zksync", "zksync"), ["sent to 0xbr…00aa"]);
  assert.deepEqual(lines(run({ legs, coins: [ownerCoins[0]], priceOf: () => null }), "zksync", "zksync"), ["sent to 0xbr…00aa"]);
});

test("rule 4 and 5: a known destination by name, any other address shortened, none recorded said so", () => {
  const legs = [
    leg({ chain: "arb", txHash: "0xa", occurredAt: "2026-10-08T10:00:00Z", direction: "out", ticker: "USDC", amount: 500, counterparty: "0x2DF1C51E09AECF9CACB7BC98CB1742757F163DF7" }),
    leg({ chain: "arb", txHash: "0xb", occurredAt: "2026-10-08T11:00:00Z", direction: "out", ticker: "USDC", amount: 200, counterparty: "0x12345678900000000000000000000000000000ab" }),
    leg({ chain: "solana", txHash: "sigc", occurredAt: "2026-10-08T12:00:00Z", direction: "out", ticker: "USDC", amount: 100, counterparty: null }),
  ];
  const r = run({ legs, coins: [coin("usd-coin", "USDC", 800, 1)] });
  assert.deepEqual(
    (r.byCoin.get(coinKey(MAIN, "usd-coin")) ?? []).map((d) => destinationText(d, "USDC", true)),
    ["500 USDC → Hyperliquid", "200 USDC sent to 0x12…00ab", "100 USDC sent out (recipient not recorded)"],
  );
});

test("several out-legs to the same place are one line; to different places, largest first", () => {
  const legs = [
    leg({ chain: "arb", txHash: "0x1", occurredAt: "2026-10-08T10:00:00Z", direction: "out", ticker: "USDC", amount: 100, counterparty: HL_CCTP }),
    leg({ chain: "arb", txHash: "0x2", occurredAt: "2026-10-09T10:00:00Z", direction: "out", ticker: "usdc", amount: 300, counterparty: HL_CCTP }),
    leg({ chain: "arb", txHash: "0x3", occurredAt: "2026-10-09T11:00:00Z", direction: "out", ticker: "USDC", amount: 50, counterparty: "0x1ed6000000000000000000000000000000000002" }),
  ];
  const d = run({ legs, coins: [coin("usd-coin", "USDC", 450, 1)] }).byCoin.get(coinKey(MAIN, "usd-coin"))!;
  assert.deepEqual(d.map((x) => [x.kind, x.amount]), [["destination", 400], ["moved", 50]]);
});

test("unknown when the history isn't synced over the window, never a guess", () => {
  const stale = wallets.map((w) => ({ ...w, txSyncedAt: "2026-09-17T20:35:21.703+00:00" }));
  assert.deepEqual(lines(run({ wallets: stale }), "zksync", "zksync"), ["where it went: not in synced history"]);
  const never = wallets.map((w) => ({ ...w, txSyncedAt: null }));
  assert.deepEqual(run({ wallets: never }).byCoin.get(coinKey(MAIN, "zksync")), [{ kind: "unknown", amount: 29_000, reason: "not-synced" }]);
});

test("unknown when the read was capped after the window started", () => {
  const r = run({ coveredFrom: "2026-10-07T19:00:00Z" });
  assert.deepEqual(r.byCoin.get(coinKey(MAIN, "zksync")), [{ kind: "unknown", amount: 29_000, reason: "not-synced" }]);
});

test("the part of a drop no out-leg explains is unknown; a coin without a symbol is all unknown", () => {
  const d = run({ coins: [coin("wrapped-eeth", "WEETH", 1.1, 4_790)] }).byCoin.get(coinKey(MAIN, "wrapped-eeth"))!;
  assert.deepEqual(d.map((x) => [x.kind, Math.round(x.amount * 100) / 100]), [["unknown", 1], ["trade", 0.1]]);
  assert.deepEqual(run({ coins: [coin("zksync", null, 29_000, 0.0118)] }).byCoin.get(coinKey(MAIN, "zksync")), [{ kind: "unknown", amount: 29_000, reason: "not-found" }]);
});

test("legs before the window's start are left out", () => {
  const early = [leg({ chain: "arb", txHash: "0xold", occurredAt: "2026-10-07T05:59:00Z", direction: "out", ticker: "USDC", amount: 75, counterparty: HL_CCTP })];
  assert.deepEqual(lines(run({ legs: early, coins: [coin("usd-coin", "USDC", 75, 1)] }), "usd-coin", "USDC"), ["where it went: not in synced history"]);
});

test("the one hop: proceeds sent on only in part don't get the next destination", () => {
  const legs = [...ownerLegs.slice(0, 2), leg({ chain: "arb", txHash: "0xhl", occurredAt: "2026-10-07T19:45:30Z", direction: "out", ticker: "USDC", amount: 200, counterparty: HL_CCTP })];
  assert.deepEqual(lines(run({ legs, coins: [ownerCoins[0]] }), "zksync", "zksync"), ["→ 342.18 USDC on Arbitrum"]);
});

test("an arrival is the other side of one swap only", () => {
  const legs = [
    ownerLegs[0],
    leg({ chain: "zksync", txHash: "0xzk2", occurredAt: "2026-10-07T19:40:45Z", direction: "out", ticker: "ZK", amount: 29_000, counterparty: "0xbridge00000000000000000000000000000000aa" }),
    ownerLegs[1],
  ];
  const d = run({ legs, coins: [coin("zksync", "ZK", 58_000, 0.0118)] }).byCoin.get(coinKey(MAIN, "zksync"))!;
  assert.deepEqual(d.map((x) => x.kind).sort(), ["crossChainSwap", "sent"]);
});

test("tickersToName: every out-leg's ticker and the arrivals near one", () => {
  assert.deepEqual(tickersToName(ownerLegs), ["ETH", "SAND", "USDC", "WEETH", "ZK"]);
  const far = [ownerLegs[0], leg({ chain: "arb", txHash: "0xlate", occurredAt: "2026-10-08T19:40:52Z", direction: "in", ticker: "ARB", amount: 1 })];
  assert.deepEqual(tickersToName(far), ["ZK"]);
});
