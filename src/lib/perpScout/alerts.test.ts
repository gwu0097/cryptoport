import { test } from "node:test";
import assert from "node:assert/strict";
import { alertMessage, closeResult, diffBook, takeBudget, type Book, type ReadPosition } from "./alerts.ts";
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

test("only an open pings; a close says its result and colour", () => {
  const ctx = { traderName: "Swing #3", address: "0xabc" };
  const opened = alertMessage({ kind: "opened", coin: "BTC", side: "long", now: pos("BTC", 2) }, { ...ctx, accountValue: 4_000, tpsl: { tp: 130, sl: null } });
  assert.equal(opened.ping, true);
  assert.equal(opened.embed.title, "🟢 Swing #3 opened LONG BTC · 5x");
  assert.match(opened.embed.description, /Size \$200 \(5% of account\) · entry \$100\.00 · liq \$80\.00\nTP \$130\.00 · SL none/);

  const was = { ...pos("BTC", 2), alertedSzi: 2, alertedAt: T0 };
  const lost = alertMessage({ kind: "closed", coin: "BTC", side: "long", was }, { ...ctx, result: { exitPx: 90, pnlUsd: -20, returnPct: -0.1 } });
  assert.equal(lost.ping, false);
  assert.equal(lost.embed.title, "❌ Swing #3 closed LONG BTC · -10.0%");
  assert.match(lost.embed.description, /Entry \$100\.00 → exit \$90\.00 · -10\.0% \(-50\.0% on margin at 5x\) · this exit's PnL −\$20/);

  const unknown = alertMessage({ kind: "closed", coin: "BTC", side: "long", was }, { ...ctx, result: null });
  assert.equal(unknown.embed.title, "⚪ Swing #3 closed LONG BTC");
});
