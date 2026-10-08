import { test } from "node:test";
import assert from "node:assert/strict";
import { addPrice, alertMessage, closeResult, diffBook, heldFor, takeBudget, type Book, type ReadPosition } from "./alerts.ts";
import type { Fill } from "./entries.ts";

const pos = (coin: string, szi: number, extra: Partial<ReadPosition> = {}): ReadPosition => ({ coin, szi, entryPx: 100, leverage: 5, liquidationPx: 80, notionalUsd: Math.abs(szi) * 100, ...extra });
const T0 = 1_000_000;

test("a trader seen for the first time only sets the baseline", () => {
  const { changes, book } = diffBook(null, [pos("BTC", 2)], T0);
  assert.deepEqual(changes, []);
  assert.equal(book.BTC.alertedSzi, 2);
});

test("opened, closed and flipped", () => {
  const prev = diffBook(null, [pos("BTC", 2), pos("ETH", -3)], T0).book;
  const { changes } = diffBook(prev, [pos("ETH", 1), pos("SOL", 10)], T0 + 30_000);
  const kinds = changes.map((c) => `${c.kind}:${c.coin}:${c.side}`).sort();
  assert.deepEqual(kinds, ["closed:BTC:long", "flipped:ETH:long", "opened:SOL:long"]);
});

test("adds and trims post only once they reach STEP from the last alert, scaling in included", () => {
  let book: Book = diffBook(null, [pos("BTC", 10)], T0).book;
  const step = (szi: number) => {
    const r = diffBook(book, [pos("BTC", szi)], T0);
    book = r.book;
    return r.changes.map((c) => c.kind);
  };
  assert.deepEqual(step(11), []); // +10%
  assert.deepEqual(step(12), []); // +20%
  assert.deepEqual(step(13), ["added"]); // +30% from 10: posts, baseline 13
  assert.equal(book.BTC.alertedSzi, 13);
  assert.deepEqual(step(11), []); // −15%
  assert.deepEqual(step(9.5), ["trimmed"]); // −27%
});

const fill = (f: Partial<Fill>): Fill => ({ coin: "BTC", px: 110, sz: 1, side: "A", time: T0 + 1, startPosition: 2, oid: 1, ...f });

test("a close's exit averages the reducing fills after the last alert, the flip's closing part only", () => {
  const was = { ...pos("BTC", 2), alertedSzi: 2, alertedAt: T0 };
  const r = closeResult(
    [
      fill({ time: T0 - 5, px: 50 }), // before the last alert: not this exit
      fill({ px: 110, sz: 1, startPosition: 2, closedPnl: 10 }),
      fill({ px: 120, sz: 3, startPosition: 1, closedPnl: 20 }), // flips: only 1 closes
      fill({ side: "B", startPosition: -2, px: 999 }), // a buy: not an exit of a long
    ],
    was,
  );
  assert.ok(r);
  assert.equal(r.exitPx, 115);
  assert.equal(r.pnlUsd, 30);
  assert.ok(Math.abs((r.returnPct ?? 0) - 0.15) < 1e-9);
  assert.equal(closeResult([], was), null);
});

test("a short's return is the fall", () => {
  const was = { ...pos("ETH", -2), alertedSzi: -2, alertedAt: T0 };
  const r = closeResult([fill({ coin: "ETH", side: "B", startPosition: -2, sz: 2, px: 90 })], was);
  assert.ok(Math.abs((r?.returnPct ?? 0) - 0.1) < 1e-9);
});

test("at most 10 messages per trader an hour", () => {
  const sent: number[] = [];
  for (let i = 0; i < 10; i++) assert.equal(takeBudget(sent, T0 + i), true);
  assert.equal(takeBudget(sent, T0 + 11), false);
  assert.equal(takeBudget(sent, T0 + 3_600_001), true);
});

test("opens and closes ping; a close says its result and colour", () => {
  const ctx = { traderName: "Swing #3", address: "0xabc" };
  const opened = alertMessage({ kind: "opened", coin: "BTC", side: "long", now: pos("BTC", 2) }, { ...ctx, accountValue: 4_000, tpsl: { tp: 130, sl: null } });
  assert.equal(opened.ping, true);
  assert.equal(opened.embed.title, "🟢 Swing #3 opened LONG BTC · 5x");
  assert.match(opened.embed.description, /Size \$200 \(5% of account\) · entry \$100\.00 · liq \$80\.00\nTP \$130\.00 · SL none/);

  const was = { ...pos("BTC", 2), alertedSzi: 2, alertedAt: T0 };
  const lost = alertMessage({ kind: "closed", coin: "BTC", side: "long", was }, { ...ctx, result: { exitPx: 90, pnlUsd: -20, returnPct: -0.1 } });
  assert.equal(lost.ping, true);
  assert.equal(lost.embed.title, "❌ Swing #3 closed LONG BTC · -10.0%");
  assert.match(lost.embed.description, /Entry \$100\.00 → exit \$90\.00 · -10\.0% \(-50\.0% on margin at 5x\) · this exit's PnL −\$20/);

  const unknown = alertMessage({ kind: "closed", coin: "BTC", side: "long", was }, { ...ctx, result: null });
  assert.equal(unknown.embed.title, "⚪ Swing #3 closed LONG BTC");
});

test("held time reads like a person would say it", () => {
  assert.equal(heldFor(40 * 60_000), "40 min");
  assert.equal(heldFor((5 * 60 + 20) * 60_000), "5h 20m");
  assert.equal(heldFor((3 * 24 + 4) * 3_600_000), "3d 4h");
});

test("when a position was opened survives reads that change nothing, and an add or trim", () => {
  let book: Book = diffBook(null, [pos("BTC", 10)], T0).book;
  book.BTC.openedAt = T0 - 86_400_000;
  book = diffBook(book, [pos("BTC", 10.5)], T0 + 1).book;
  assert.equal(book.BTC.openedAt, T0 - 86_400_000);
  book = diffBook(book, [pos("BTC", 20)], T0 + 2).book;
  assert.equal(book.BTC.openedAt, T0 - 86_400_000);
  const opened = diffBook(book, [pos("BTC", 20), pos("ETH", 1)], T0 + 3).book;
  assert.equal(opened.ETH.openedAt, T0 + 3);
});

test("an add's price averages only the buys that grew it since the last alert", () => {
  const was = { ...pos("HYPE", 10), alertedSzi: 10, alertedAt: T0 };
  const px = addPrice(
    [
      fill({ coin: "HYPE", side: "B", startPosition: 5, sz: 5, px: 1, time: T0 - 1 }), // before the last alert
      fill({ coin: "HYPE", side: "B", startPosition: 10, sz: 4, px: 90 }),
      fill({ coin: "HYPE", side: "B", startPosition: 14, sz: 6, px: 95 }),
      fill({ coin: "HYPE", side: "A", startPosition: 20, sz: 1, px: 999 }), // a sell
    ],
    was,
  );
  assert.equal(px, 93);
});

test("a trim says the size before and after, the share of the account, the sale and what's still open", () => {
  const was = { ...pos("ETH", 10, { entryPx: 2000 }), alertedSzi: 10, alertedAt: T0, openedAt: T0 - 3 * 86_400_000 };
  const now = pos("ETH", 4, { entryPx: 2000, notionalUsd: 4 * 2500, leverage: 8, roe: 2.0, unrealizedPnl: 2000 });
  const msg = alertMessage({ kind: "trimmed", coin: "ETH", side: "long", was, now }, {
    traderName: "Hot month",
    address: "0xabc",
    accountValue: 100_000,
    result: { exitPx: 2500, pnlUsd: 3000, returnPct: 0.25 },
    openedAt: was.openedAt,
    nowMs: T0,
  });
  assert.equal(msg.embed.title, "🟠 Hot month trimmed LONG ETH (-60.0%) · held 3d 0h");
  const [size, sold, open] = msg.embed.description.split("\n");
  assert.equal(size, "Size $25K → $10K · now 10% of account (was 25%) · 8x");
  assert.equal(sold, "Sold at $2,500.00 (+25.0% vs entry $2,000.00) · this trim's PnL +$3K");
  assert.equal(open, "Still open: open PnL +200.0% on margin · +$2K");
});

test("an add says what it was bought at; an unknown opening time is left out", () => {
  const was = { ...pos("HYPE", 10, { entryPx: 85 }), alertedSzi: 10, alertedAt: T0 };
  const now = pos("HYPE", 19.3, { entryPx: 88.9, notionalUsd: 19.3 * 90, leverage: 5 });
  const msg = alertMessage({ kind: "added", coin: "HYPE", side: "long", was, now }, { traderName: "Swing cb34", address: "0xabc", accountValue: 20_000, addPx: 92.6, nowMs: T0 });
  assert.equal(msg.embed.title, "🔵 Swing cb34 added to LONG HYPE (+93.0%)");
  assert.match(msg.embed.description, /^Size \$900 → \$1\.7K · now 8\.7% of account \(was 4\.5%\) · 5x\nBought at \$92\.60 · avg entry now \$88\.90/);
});

test("adds, trims and flips don't ping", () => {
  const was = { ...pos("BTC", 2), alertedSzi: 2, alertedAt: T0 };
  const ctx = { traderName: "X", address: "0xabc" };
  assert.equal(alertMessage({ kind: "added", coin: "BTC", side: "long", was, now: pos("BTC", 3) }, ctx).ping, false);
  assert.equal(alertMessage({ kind: "trimmed", coin: "BTC", side: "long", was, now: pos("BTC", 1) }, ctx).ping, false);
  assert.equal(alertMessage({ kind: "flipped", coin: "BTC", side: "short", was, now: pos("BTC", -2) }, ctx).ping, false);
});
