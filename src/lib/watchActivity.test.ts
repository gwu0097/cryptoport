import test from "node:test";
import assert from "node:assert/strict";
import { appendLegs, coinDays, contractFromKey, dayLines, rebaseToDay, todaysReadTime, toLegs, trimToBoundary, type ActivityLeg, type RawChange, type TxActivity } from "./watchActivity.ts";

const SOL = 120;
const known: Record<string, { assetKey: string; priceKey: string; ticker: string }> = {
  "solana|native": { assetKey: "solana", priceKey: "solana", ticker: "SOL" },
  "solana|gem": { assetKey: "jup:gem", priceKey: "jup:gem", ticker: "GEM" },
  "eth|native": { assetKey: "ethereum", priceKey: "ethereum", ticker: "ETH" },
  "arb|0xtok": { assetKey: "tok", priceKey: "tok", ticker: "TOK" },
  "rbh|bucket": { assetKey: "bucket-shop", priceKey: "bucket-shop", ticker: "BUCKET" },
  "rbh|statics": { assetKey: "statics-protocol", priceKey: "statics-protocol", ticker: "STATICS" },
};
const identify = (c: RawChange) => known[`${c.chain}|${c.contract ?? "native"}`] ?? null;
const valueOf = (k: string | null) => (k === "solana" ? SOL : k === "ethereum" ? 4000 : null);
const NO_NATIVE = new Set(["arb"]);
const chg = (txId: string, chain: string, contract: string | null, qty: number, at = "2026-09-28T10:00:00Z", counterparty: string | null = null): RawChange => ({ txId, at, chain, contract, symbol: null, qty, counterparty });

test("a swap: SOL out, gem in — the gem is priced by the SOL leg", () => {
  const legs = toLegs([chg("t1", "solana", null, -2.4), chg("t1", "solana", "gem", 1_000_000)], identify, valueOf, NO_NATIVE, "2026-09-28T12:00:00Z");
  const gem = legs.find((l) => l.ticker === "GEM")!;
  assert.equal(gem.kind, "swap");
  assert.ok(Math.abs(gem.priceUsd! - (2.4 * SOL) / 1_000_000) < 1e-12);
  assert.equal(legs.find((l) => l.ticker === "SOL")!.priceUsd, SOL);
});

test("spam and fees: an unknown token received is dropped; a lone SOL fee is dust", () => {
  const legs = toLegs([chg("t2", "solana", "spam", 5_000_000), chg("t3", "solana", null, -0.002)], identify, valueOf, NO_NATIVE, "x");
  assert.deepEqual(legs, []);
});

test("buying an unrecognized coin still counts the SOL as a swap leg, not a transfer out", () => {
  const legs = toLegs([chg("t4", "solana", null, -3), chg("t4", "solana", "unknown-mint", 42)], identify, valueOf, NO_NATIVE, "x");
  assert.equal(legs.length, 1);
  assert.equal(legs[0].kind, "swap");
});

test("a lone token out on a chain that can't show native legs is unclear, elsewhere a transfer", () => {
  assert.equal(toLegs([chg("t5", "arb", "0xtok", -10)], identify, valueOf, NO_NATIVE, "x")[0].kind, "unclear");
  assert.equal(toLegs([chg("t6", "solana", "gem", -10)], identify, valueOf, NO_NATIVE, "x")[0].kind, "transfer");
});

const leg = (over: Partial<ActivityLeg>): ActivityLeg => ({
  txId: "t",
  assetKey: "jup:gem",
  sourceChain: "solana",
  priceKey: "jup:gem",
  ticker: "GEM",
  qtyDelta: 0,
  kind: "swap",
  counterparty: null,
  priceUsd: 0.01,
  at: "2026-09-28T10:00:00Z",
  checkedAt: "2026-09-28T12:00:00Z",
  ...over,
});
const day = (legs: ActivityLeg[], base: TxActivity["base"] = {}): TxActivity => ({ boundary: "2026-09-28T08:00:00Z", legs, base });

test("two small adds are judged together against the morning quantity", () => {
  const base = { "jup:gem": { qty: 1_000_000, kept: false } }; // $10,000 at $0.01
  // Each +3% ($300) would pass on its own now (1%), so use +0.6% each: only together ≥ 1%.
  const one = [leg({ txId: "a", qtyDelta: 6_000 })];
  assert.deepEqual(dayLines([day(one, base)], new Set(), () => 0.01), []);
  const both = [leg({ txId: "a", qtyDelta: 6_000 }), leg({ txId: "b", qtyDelta: 6_000 })];
  const lines = dayLines([day(both, base)], new Set(), () => 0.01);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "added");
});

test("a new gem with no stored price is sized by its trade price", () => {
  const lines = dayLines([day([leg({ qtyDelta: 50_000, priceUsd: 0.01 })])], new Set(), () => null);
  assert.equal(lines[0].kind, "new");
  assert.equal(Math.round(lines[0].usdDelta), 500);
});

test("transfers between the influencer's own addresses cancel; a carried-forward coin is never sized", () => {
  const moved = [leg({ kind: "transfer", qtyDelta: -50_000, counterparty: "Other1", priceUsd: null })];
  assert.deepEqual(dayLines([day(moved, { "jup:gem": { qty: 60_000, kept: false } })], new Set(["other1"]), () => 0.01), []);
  const kept = [leg({ qtyDelta: 50_000 })];
  assert.deepEqual(dayLines([day(kept, { "jup:gem": { qty: 1, kept: true } })], new Set(), () => 0.01), []);
});

test("legs before the boundary never count; appending dedupes and a new read's boundary drops the old day", () => {
  const early = leg({ txId: "old", qtyDelta: 90_000, at: "2026-09-28T07:59:00Z" });
  assert.deepEqual(dayLines([day([early])], new Set(), () => 0.01), []);
  const first = appendLegs(null, "2026-09-28T08:00:00Z", [leg({ txId: "a", qtyDelta: 1 })], {});
  const again = appendLegs(first, "2026-09-28T08:00:00Z", [leg({ txId: "a", qtyDelta: 1 }), leg({ txId: "b", qtyDelta: 2 })], {});
  assert.deepEqual(again.legs.map((l) => l.txId), ["a", "b"]);
  const next = trimToBoundary(again, "2026-09-29T08:00:00Z");
  assert.deepEqual(next?.legs, []);
});

test("the copied contract is the token's own, never guessed", () => {
  assert.equal(contractFromKey("jup:HSUMi4rMgjrx7zRUabw3ogGu1pa5hmF2eVcXj9Apump"), "HSUMi4rMgjrx7zRUabw3ogGu1pa5hmF2eVcXj9Apump");
  assert.equal(contractFromKey("eth:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"), "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984");
  assert.equal(contractFromKey("hl:PURR"), null);
  assert.equal(contractFromKey("uniswap"), null);
  const line = dayLines([day([leg({ qtyDelta: 50_000, contract: "Mint111111111111111111111111111111" })])], new Set(), () => 0.01)[0];
  assert.equal(line.contract, "Mint111111111111111111111111111111");
  assert.equal(line.contractChain, "solana");
});

test("a flip within the day is its own line — Hash's DUKE, bought and sold 9 minutes later at -63%", () => {
  const legs = [
    leg({ txId: "b1", qtyDelta: 20_808_096, priceUsd: 0.0000144, at: "2026-09-28T18:00:34Z" }),
    leg({ txId: "b2", qtyDelta: 8_062_262, priceUsd: 0.0000149, at: "2026-09-28T18:02:05Z" }),
    leg({ txId: "s1", qtyDelta: -28_870_358, priceUsd: 0.00000542, at: "2026-09-28T18:09:35Z" }),
  ];
  const lines = dayLines([day(legs)], new Set(), () => 0.0000054);
  assert.equal(lines.length, 1); // net zero: only the round trip
  const t = lines[0];
  assert.equal(t.kind, "roundtrip");
  assert.ok(t.roundTrip!.pnlPct < -60 && t.roundTrip!.pnlPct > -65);
  assert.ok(t.usdDelta < -250 && t.usdDelta > -280);
});

test("a sale of morning holdings before any buy is not a round trip", () => {
  const legs = [leg({ txId: "s", qtyDelta: -10_000, priceUsd: 0.02, at: "2026-09-28T09:00:00Z" }), leg({ txId: "b", qtyDelta: 10_000, priceUsd: 0.02, at: "2026-09-28T10:00:00Z" })];
  assert.ok(dayLines([day(legs, { "jup:gem": { qty: 50_000, kept: false } })], new Set(), () => 0.02).every((l) => l.kind !== "roundtrip"));
});

test("SOL in and out is cash, never a round trip", () => {
  const legs = [
    leg({ assetKey: "solana", priceKey: "solana", ticker: "SOL", txId: "a", qtyDelta: 3.1, priceUsd: 119.6, at: "2026-09-28T18:00:00Z" }),
    leg({ assetKey: "solana", priceKey: "solana", ticker: "SOL", txId: "b", qtyDelta: -3.1, priceUsd: 119.58, at: "2026-09-28T18:27:00Z" }),
  ];
  assert.ok(dayLines([day(legs)], new Set(), () => 119.58).every((l) => l.kind !== "roundtrip"));
});

test("a net buy is priced by its latest buys, not an earlier round trip (Hash's NIBS)", () => {
  const legs = [
    leg({ txId: "a", qtyDelta: 11_605_144, priceUsd: 0.00004323, at: "2026-09-28T20:10:52Z" }),
    leg({ txId: "b", qtyDelta: -11_605_144, priceUsd: 0.00003233, at: "2026-09-28T20:11:50Z" }),
    leg({ txId: "c", qtyDelta: 19_408_175, priceUsd: 0.00005, at: "2026-09-28T20:51:54Z" }),
  ];
  const net = dayLines([day(legs)], new Set(), () => 0.0000444).find((l) => l.kind === "new")!;
  assert.equal(net.tradePrice, 0.00005);
});

test("per coin, like a trading app: four NIBS buys and a sale, paid in SOL; SOL itself isn't a coin", () => {
  const sol = (txId: string, qty: number, at: string) => leg({ txId, assetKey: "solana", priceKey: "solana", ticker: "SOL", qtyDelta: qty, priceUsd: 118, at });
  const nibs = (txId: string, qty: number, price: number, at: string) => leg({ txId, assetKey: "jup:nibs", priceKey: "jup:nibs", ticker: "NIBS", qtyDelta: qty, priceUsd: price, at });
  const legs = [
    sol("b1", -8.08, "2026-09-28T20:51:54Z"), nibs("b1", 19_400_000, 0.0000491, "2026-09-28T20:51:54Z"),
    sol("b2", -0.869, "2026-09-28T20:58:31Z"), nibs("b2", 2_330_000, 0.000044, "2026-09-28T20:58:31Z"),
    sol("b3", -1.98, "2026-09-28T21:02:08Z"), nibs("b3", 6_380_000, 0.0000366, "2026-09-28T21:02:08Z"),
    sol("b4", -0.988, "2026-09-28T21:06:01Z"), nibs("b4", 2_410_000, 0.0000484, "2026-09-28T21:06:01Z"),
    sol("s1", 3.52, "2026-09-28T21:39:01Z"), nibs("s1", -30_520_000, 0.0000136, "2026-09-28T21:39:01Z"),
  ];
  const days = coinDays([day(legs)], new Set());
  assert.deepEqual(days.map((d) => d.ticker), ["NIBS"]); // no SOL line
  const d = days[0];
  assert.equal(d.buys, 4);
  assert.equal(d.sells, 1);
  assert.equal(d.payTicker, "SOL");
  assert.ok(Math.abs(d.boughtPay! - 11.917) < 1e-9);
  assert.equal(d.soldPay, 3.52);
  assert.equal(d.holdingQty, 0);
  assert.ok(d.realizedUsd! < 0 && d.realizedPct! < -60);
  assert.deepEqual(d.trades.map((t) => t.side), ["sell", "buy", "buy", "buy", "buy"]);
  assert.equal(d.trades[0].payQty, 3.52);
});

test("selling morning holdings: the cost isn't known today, so no result is claimed", () => {
  const d = coinDays([day([leg({ txId: "s", qtyDelta: -50_000, priceUsd: 0.01 })], { "jup:gem": { qty: 80_000, kept: false } })], new Set())[0];
  assert.equal(d.realizedUsd, null);
  assert.equal(d.soldFromEarlier, true);
  assert.equal(d.holdingQty, 30_000);
});

test("average entry across many buys; a tiny trim of a big position stays out; a real trim shows its share", () => {
  const buys = [1, 2, 3].map((i) => leg({ txId: `b${i}`, qtyDelta: 10_000_000, priceUsd: 0.00001 * i, at: `2026-09-28T1${i}:00:00Z` }));
  const d = coinDays([day(buys)], new Set())[0];
  assert.ok(Math.abs(d.avgEntryUsd! - 0.00002) < 1e-12); // ($100 + $200 + $300) / 30M
  // Ben Armstrong: $148 of a $282K UNI position is 0.05% — not shown.
  const tiny = [leg({ assetKey: "uniswap", priceKey: "uniswap", ticker: "UNI", txId: "s", qtyDelta: -17, priceUsd: 8.7 })];
  assert.deepEqual(coinDays([day(tiny, { uniswap: { qty: 32_467, kept: false } })], new Set()), []);
  // Selling 12% of it is shown, with its share.
  const trim = [leg({ assetKey: "uniswap", priceKey: "uniswap", ticker: "UNI", txId: "s", qtyDelta: -3_896, priceUsd: 8.7 })];
  const t = coinDays([day(trim, { uniswap: { qty: 32_467, kept: false } })], new Set())[0];
  assert.ok(Math.abs(t.soldShareOfPosition! - 0.12) < 0.001);
});

test("a coin-for-coin swap (BUCKET → STATICS) is sized at a stored price and marked so", () => {
  const stored = (k: string | null) => (k === "bucket-shop" ? 0.005 : null); // STATICS has no stored price
  const legs = toLegs([chg("b1", "rbh", "bucket", -35_231), chg("b1", "rbh", "statics", 6_612)], identify, valueOf, NO_NATIVE, "x", stored);
  const statics = legs.find((l) => l.ticker === "STATICS")!;
  assert.equal(statics.kind, "swap");
  assert.ok(Math.abs(statics.priceUsd! - (35_231 * 0.005) / 6_612) < 1e-12);
  assert.equal(statics.sizedBy, "stored");
  // Without stored prices it stays unsized, as before.
  assert.equal(toLegs([chg("b2", "rbh", "bucket", -1), chg("b2", "rbh", "statics", 1)], identify, valueOf, NO_NATIVE, "x")[1].priceUsd, null);
});

test("a swap with a cash side never uses stored prices", () => {
  const legs = toLegs([chg("t9", "solana", null, -1), chg("t9", "solana", "gem", 100)], identify, valueOf, NO_NATIVE, "x", () => 999);
  assert.equal(legs.find((l) => l.ticker === "GEM")!.priceUsd, SOL / 100);
  assert.equal(legs.some((l) => l.sizedBy), false);
});


test("the day's read time is today's 08:00 UTC once it has passed, else yesterday's", () => {
  assert.equal(new Date(todaysReadTime(Date.parse("2026-09-29T14:30:00Z"))).toISOString(), "2026-09-29T08:00:00.000Z");
  assert.equal(new Date(todaysReadTime(Date.parse("2026-09-29T07:59:00Z"))).toISOString(), "2026-09-28T08:00:00.000Z");
});

test("a day whose read didn't happen starts at the read time; the starting quantity moves forward", () => {
  const act: TxActivity = {
    boundary: "2026-09-28T08:11:00Z",
    legs: [leg({ txId: "y", qtyDelta: 500, at: "2026-09-28T20:00:00Z" }), leg({ txId: "t", qtyDelta: -200, at: "2026-09-29T09:00:00Z" })],
    base: { "jup:gem": { qty: 1_000, kept: false } },
  };
  const r = rebaseToDay(act, Date.parse("2026-09-29T08:00:00Z"));
  assert.equal(r.boundary, "2026-09-29T08:00:00.000Z");
  assert.deepEqual(r.legs.map((l) => l.txId), ["t"]);
  assert.equal(r.base["jup:gem"].qty, 1_500);
  // Already read today: unchanged.
  assert.equal(rebaseToDay({ ...act, boundary: "2026-09-29T08:07:00Z" }, Date.parse("2026-09-29T08:00:00Z")).legs.length, 2);
});
