import test from "node:test";
import assert from "node:assert/strict";
import { alertEmbed, exitReturnPct, tokenLink, walletTradesLink, watchAlerts } from "./watchAlerts.ts";
import { appendLegs, coinDays, type ActivityLeg, type TxActivity } from "./watchActivity.ts";

const BOUNDARY = "2026-09-28T08:00:00Z";
const GEM = "jup:gem";
let n = 0;
/** One swap: the coin against SOL at $100, at `usd` per coin. */
let clock = Date.parse("2026-09-28T10:00:00Z");
function swap(qty: number, usd: number, afterMs = 1000): ActivityLeg[] {
  const txId = `tx${++n}`;
  clock += afterMs;
  const at = new Date(clock).toISOString();
  const common = { txId, sourceChain: "solana", kind: "swap" as const, counterparty: null, at, checkedAt: at, source: "webhook" as const };
  return [
    { ...common, assetKey: GEM, priceKey: GEM, ticker: "GEM", contract: "GemMint111", qtyDelta: qty, priceUsd: usd },
    { ...common, assetKey: "solana", priceKey: "solana", ticker: "SOL", contract: null, qtyDelta: (-qty * usd) / 100, priceUsd: 100 },
  ];
}
/** The alerts for `next` arriving on top of `prev` (a delivery). */
function deliver(prev: TxActivity | null, next: ActivityLeg[], heldAtRead = 0, supply: number | null = null): { alerts: ReturnType<typeof watchAlerts>; after: TxActivity } {
  const base = { [GEM]: { qty: heldAtRead, kept: false } };
  const before = prev ?? { boundary: BOUNDARY, legs: [], base };
  const after = appendLegs(before, BOUNDARY, next, base);
  const own = new Set<string>();
  return { alerts: watchAlerts(coinDays([before], own), coinDays([after], own), new Set(next.map((l) => l.txId)), () => supply), after };
}

test("Risk-style DCA: opened at $100, one ping at $200, then only the $1K and $5K steps", () => {
  let act: TxActivity | null = null;
  const got: string[] = [];
  for (let i = 0; i < 51; i++) {
    const r = deliver(act, swap(10_000, 0.01)); // $100 a buy, seconds apart
    act = r.after;
    got.push(...r.alerts.map((a) => `${a.kind}${a.ping ? "!" : ""}`));
  }
  assert.deepEqual(got, ["opened", "building!", "added", "added"]);
});

test("an open of $200 or more pings at once, with no separate 'building'", () => {
  const r = deliver(null, swap(60_000, 0.01)); // $600
  assert.deepEqual(r.alerts.map((a) => `${a.kind}${a.ping ? "!" : ""}`), ["opened!"]);
});

test("a small first buy doesn't post; the buy that reaches $100 opens it", () => {
  const a = deliver(null, swap(1_000, 0.01)); // $10
  assert.deepEqual(a.alerts, []);
  const b = deliver(a.after, swap(9_000, 0.01)); // $100 total
  assert.equal(b.alerts[0].kind, "opened");
  assert.match(b.alerts[0].detail, /2 buys/);
});

test("the same delivery twice posts once", () => {
  const legs = swap(20_000, 0.01);
  const first = deliver(null, legs);
  assert.equal(first.alerts.length, 1);
  assert.deepEqual(deliver(first.after, legs).alerts, []);
});

test("a trim posts at a quarter; selling out within the hour is a flip — posted, not pinged", () => {
  const open = deliver(null, swap(100_000, 0.01)); // $1,000 in
  const trim = deliver(open.after, swap(-30_000, 0.012)); // 30% at +20%
  assert.deepEqual(trim.alerts.map((a) => a.kind), ["trimmed"]);
  assert.equal(trim.alerts[0].headline, "trimmed GEM by 30%");
  // What the sale brought in and at what price, then the result.
  assert.equal(trim.alerts[0].detail, "received 3.60 SOL ($360.00) at $0.012\n+$60.00 (+20.0%) on what was sold");
  const out = deliver(trim.after, swap(-70_000, 0.009));
  assert.deepEqual(out.alerts.map((a) => [a.kind, a.ping]), [["soldOut", false]]);
  assert.equal(out.alerts[0].headline, "closed GEM · -1.0%");
  assert.match(out.alerts[0].detail, /^# 🔴 -\$10\.00 \(-1\.0%\)\nIn 10\.00 SOL \(\$1,000\.00\) → Out 9\.90 SOL \(\$990\.00\)\n.* · flipped in 1m$/);
  assert.equal(alertEmbed("Risk", out.alerts[0], null).title, "❌ Risk closed GEM · -1.0%");
});

test("selling out a position held over an hour posts, unpinged, and isn't a flip", () => {
  const open = deliver(null, swap(100_000, 0.01));
  const out = deliver(open.after, swap(-100_000, 0.02, 3 * 3_600_000));
  assert.deepEqual(out.alerts.map((a) => [a.kind, a.ping]), [["soldOut", false]]);
  assert.doesNotMatch(out.alerts[0].detail, /flipped/);
  assert.match(out.alerts[0].detail, / · held 3h$/);
  assert.equal(alertEmbed("Risk", out.alerts[0], null).color, 0x22c55e);
  assert.equal(out.alerts[0].headline, "closed GEM · +100.0%");
});

test("Bacon-style: the first add today to a coin held at the read posts (unpinged); its steps don't repeat it", () => {
  const r = deliver(null, swap(150_000, 0.01), 1_000_000); // $1,500 more of a $10K position
  assert.deepEqual(r.alerts.map((a) => [a.kind, a.ping]), [["resumed", false]]);
  assert.equal(r.alerts[0].headline, "added to GEM");
  assert.match(r.alerts[0].detail, /\(\$1,500\.00\) at \$0\.01 · now holds \$11,500/);
  const more = deliver(r.after, swap(500_000, 0.01)); // seconds later: $6,500 today → the $5K step, no ping
  assert.deepEqual(more.alerts.map((a) => [a.kind, a.ping]), [["added", false]]);
});

test("buys within an hour are one burst; an hour's pause starts a new one, which posts", () => {
  const open = deliver(null, swap(15_000, 0.01)); // $150: opened, quietly
  assert.deepEqual(open.alerts.map((a) => [a.kind, a.ping]), [["opened", false]]);
  const soon = deliver(open.after, swap(10_000, 0.01, 30 * 60_000)); // 30 min later: $250, the open reaches $200
  assert.deepEqual(soon.alerts.map((a) => [a.kind, a.ping]), [["building", true]]);
  const small = deliver(soon.after, swap(5_000, 0.01, 2 * 3_600_000)); // 2 h later, $50: not yet
  assert.deepEqual(small.alerts, []);
  const later = deliver(small.after, swap(6_000, 0.01, 60_000)); // same burst reaches $110
  assert.deepEqual(later.alerts.map((a) => [a.kind, a.ping]), [["resumed", false]]);
  assert.equal(later.alerts[0].headline, "added to GEM after 2h without buying");
  assert.match(later.alerts[0].detail, /^2 buys/);
});

test("a card: coloured by kind, titled with the trader, linked to the coin's page; CryptoPort only on an open", () => {
  const opened = { kind: "opened" as const, ticker: "SBC", contract: "ArV7pump", chain: "solana", headline: "opened SBC", detail: "3.23 SOL ($384.02) at $0.00002616", ping: false };
  assert.deepEqual(alertEmbed("Hash", opened, "https://x/wallet-watch/1"), {
    title: "🟢 Hash opened SBC",
    url: "https://fomo.family/tokens/solana/ArV7pump",
    description: "3.23 SOL ($384.02) at $0.00002616\n`ArV7pump`\n[Hash on CryptoPort](https://x/wallet-watch/1)",
    color: 0x22c55e,
  });
  const building = alertEmbed("Hash", { ...opened, kind: "building", headline: "is building SBC" }, "https://x/wallet-watch/1");
  assert.equal(building.description, "3.23 SOL ($384.02) at $0.00002616\n`ArV7pump`");
});

test("coin links: Fomo on Solana, DexScreener on known EVM chains, none elsewhere", () => {
  assert.equal(tokenLink("eth", "0xabc"), "https://dexscreener.com/ethereum/0xabc");
  assert.equal(tokenLink("rbh", "0xabc"), null);
  assert.equal(tokenLink("solana", null), null);
});

test("with the supply known, buys and sells show the market cap at their price", () => {
  const open = deliver(null, swap(100_000, 0.01), 0, 1_000_000_000); // 1B supply at $0.01 → $10M
  assert.equal(open.alerts[0].detail, "10.00 SOL ($1,000.00) at $0.01 · MC $10M");
  const out = deliver(open.after, swap(-100_000, 0.02, 3 * 3_600_000), 0, 1_000_000_000);
  assert.equal(out.alerts[0].kind, "soldOut");
  assert.equal(out.alerts[0].detail, "# 🟢 +$1,000.00 (+100.0%)\nIn 10.00 SOL ($1,000.00) → Out 20.00 SOL ($2,000.00)\nExit $0.02 · MC $20M · held 3h");
});

test("without a supply, no market cap is shown (never a guessed one)", () => {
  const open = deliver(null, swap(100_000, 0.01));
  assert.doesNotMatch(open.alerts[0].detail, /MC/);
});

test("the exit return falls back to the coin paid with when a buy has no dollar price", () => {
  const c = { soldFromEarlier: false, boughtQty: 1000, soldQty: 1000, realizedPct: null, boughtPay: 6.25, soldPay: 40.7 } as unknown as Parameters<typeof exitReturnPct>[0];
  assert.equal(Math.round(exitReturnPct(c)!), 551);
  assert.equal(exitReturnPct({ ...c, soldFromEarlier: true }), null); // earlier cost unknown
  assert.equal(exitReturnPct({ ...c, boughtPay: null }), null);
});

test("a close carries its image's figures, and its card shows the attached image", () => {
  const open = deliver(null, swap(100_000, 0.01), 0, 1_000_000_000);
  const out = deliver(open.after, swap(-100_000, 0.02, 3 * 3_600_000), 0, 1_000_000_000);
  const a = out.alerts[0];
  assert.deepEqual(a.card, { ticker: "GEM", payTicker: "SOL", pct: "+100.0%", win: true, result: "+$1,000.00", inText: "10.00 SOL ($1,000.00)", outText: "20.00 SOL ($2,000.00)", held: "held 3h", entryMc: "$10M", exitMc: "$20M" });
  const withImage = alertEmbed("Risk", a, null, "close-1.png");
  assert.deepEqual(withImage.image, { url: "attachment://close-1.png" });
  assert.equal(withImage.description, "`GemMint111`"); // the image carries the numbers
  assert.match(alertEmbed("Risk", a, null).description, /^# 🟢/); // no image: the text keeps them
  assert.equal(open.alerts[0].card, undefined); // an open has no image
});

test("every card links the wallet's trades beside the contract: Solscan for Solana, DeBank for EVM", () => {
  const open = deliver(null, swap(100_000, 0.01));
  const e = alertEmbed("Risk", open.alerts[0], null, undefined, walletTradesLink("SOL", "Addr1"));
  assert.match(e.description, /`GemMint111` · \[Wallet trades ↗\]\(https:\/\/solscan\.io\/account\/Addr1#defiactivities\)$/);
  assert.equal(walletTradesLink("ETH", "0xabc")?.url, "https://debank.com/profile/0xabc/history");
  assert.equal(walletTradesLink("BTC", "bc1q"), null);
});

test("an open shows the liquidity at entry when it was captured", () => {
  const legs = swap(100_000, 0.01);
  legs[0].entryLiqUsd = 7_200;
  const open = deliver(null, legs, 0, 1_000_000_000);
  assert.equal(open.alerts[0].detail, "10.00 SOL ($1,000.00) at $0.01 · MC $10M · Liq $7.2K");
});
