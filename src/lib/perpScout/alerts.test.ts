import { test } from "node:test";
import assert from "node:assert/strict";
import { addPrice, alertMessage, closeResult, diffBook, heldFor, table, takeBudget, type Book, type ReadPosition } from "./alerts.ts";
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



test("adds, trims and flips don't ping", () => {
  const was = { ...pos("BTC", 2), alertedSzi: 2, alertedAt: T0 };
  const ctx = { traderName: "X", address: "0xabc" };
  assert.equal(alertMessage({ kind: "added", coin: "BTC", side: "long", was, now: pos("BTC", 3) }, ctx).ping, false);
  assert.equal(alertMessage({ kind: "trimmed", coin: "BTC", side: "long", was, now: pos("BTC", 1) }, ctx).ping, false);
  assert.equal(alertMessage({ kind: "flipped", coin: "BTC", side: "short", was, now: pos("BTC", -2) }, ctx).ping, false);
});

test("a table is one header row and one value row, columns lined up", () => {
  assert.equal(table([["Entry", "$0.6640"], ["P/L", "+36.6%"], ["Held", "15h05m"]]), "```\nEntry    P/L     Held\n$0.6640  +36.6%  15h05m\n```");
});

test("an open: green, pings, its title then lev/entry/size/%acct/liq/TP/SL", () => {
  const m = alertMessage({ kind: "opened", coin: "GRASS", side: "long", now: pos("GRASS", 7500, { entryPx: 0.62, notionalUsd: 4650, leverage: 3, liquidationPx: null }) }, { traderName: "Swing 95da", address: "0xabc", accountValue: 2_000_000, tpsl: { tp: null, sl: null } });
  assert.equal(m.ping, true);
  assert.equal(m.embed.color, 0x22c55e);
  assert.equal(m.embed.title, "🟢 OPEN · Swing 95da · GRASS LONG");
  assert.match(m.embed.description, /^```\nEntry +Size +Lev +Liq +TP +SL +% Acct\n\$0\.62\d* +\$4\.\d+K +3x +— +none +none +0\.2%\n```/);
  assert.deepEqual({ kind: m.card.kind, title: m.card.title, headline: m.card.headline, accent: m.card.accent }, { kind: "OPENED", title: "GRASS LONG", headline: "0.2% of acct", accent: "#22c55e" });
});

test("a close: the whole position's result, green or red, pings", () => {
  const was = { ...pos("GRASS", 75_000, { entryPx: 0.664, notionalUsd: 56_000, leverage: 3 }), alertedSzi: 75_000, alertedAt: T0 };
  const win = alertMessage({ kind: "closed", coin: "GRASS", side: "long", was }, { traderName: "Swing 95da", address: "0xabc", accountValue: 2_000_000, result: { exitPx: 0.7451, pnlUsd: 6109, returnPct: 0.1222 }, openedAt: T0 - (15 * 60 + 5) * 60_000, nowMs: T0 });
  assert.equal(win.ping, true);
  assert.equal(win.embed.color, 0x22c55e);
  assert.equal(win.embed.title, "✅ CLOSE · Swing 95da · GRASS LONG · +12.2%");
  assert.deepEqual({ kind: win.card.kind, headline: win.card.headline, tone: win.card.headTone }, { kind: "CLOSED · WIN", headline: "+36.7%", tone: "pos" });
  assert.equal(win.card.cells.find((c) => c.label === "$ P/L")?.tone, "pos");
  assert.match(win.embed.description, /Entry +Exit +Move +Lev +P\/L +\$ P\/L +% Acct +Held\n\$0\.664\d* +\$0\.745\d* +\+12\.2% +3x +\+36\.7% +\+\$6\.1K +2\.8% +15h05m/);
  const loss = alertMessage({ kind: "closed", coin: "GRASS", side: "long", was }, { traderName: "Swing 95da", address: "0xabc", result: { exitPx: 0.6, pnlUsd: -500, returnPct: -0.0964 } });
  assert.equal(loss.embed.color, 0xef4444);
  assert.match(loss.embed.title, /^❌ CLOSE/);
  const unknown = alertMessage({ kind: "closed", coin: "GRASS", side: "long", was }, { traderName: "Swing 95da", address: "0xabc", result: null });
  assert.equal(unknown.embed.title, "⚪ CLOSE · Swing 95da · GRASS LONG");
});

test("an add is blue, a trim amber, neither pings; each names its size, price and P/L", () => {
  const was = { ...pos("HYPE", 10, { entryPx: 85 }), alertedSzi: 10, alertedAt: T0 };
  const add = alertMessage({ kind: "added", coin: "HYPE", side: "long", was, now: pos("HYPE", 19.3, { entryPx: 88.9, notionalUsd: 19.3 * 90, leverage: 5, roe: -0.003 }) }, { traderName: "Swing cb34", address: "0xabc", accountValue: 20_000, addPx: 92.6 });
  assert.equal(add.ping, false);
  assert.equal(add.embed.color, 0x3b82f6);
  assert.equal(add.embed.title, "🔵 ADD · Swing cb34 · HYPE LONG · +93.0%");
  assert.match(add.embed.description, /Added +Price +Size +% Acct +Lev +Avg entry +P\/L +Held\n\+\$837 +\$92\.60 +\$1\.7K +8\.7% +5x +\$88\.90 +-0\.30% +—/);
  const trim = alertMessage({ kind: "trimmed", coin: "HYPE", side: "long", was, now: pos("HYPE", 4, { notionalUsd: 360 }) }, { traderName: "X", address: "0xabc", result: { exitPx: 95, pnlUsd: 50, returnPct: 0.1 } });
  assert.equal(trim.embed.color, 0xf59e0b);
  assert.match(trim.embed.title, /^🟠 TRIM · X · HYPE LONG · -60\.0%/);
  assert.match(trim.embed.description, /^```\nSold +Price/);
});
