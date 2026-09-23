import test from "node:test";
import assert from "node:assert/strict";
import { buildBlocks, rma, computeSmc, triggerPrice, type Candle } from "./engine.ts";

const H = 3600;

/** Hourly candles from `startSec`, with closes following `closes` and each
 * candle opening at the previous close. */
function hourly(startSec: number, closes: number[]): Candle[] {
  let prev = closes[0];
  return closes.map((c, i) => {
    const candle = { t: startSec + i * H, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c };
    prev = c;
    return candle;
  });
}

test("rma matches Pine's ta.rma: null until n-1, seeded with the mean, then Wilder's recurrence", () => {
  const r = rma([1, 2, 3, 4, 5, 6, 7, 8, 16], 8);
  assert.deepEqual(r.slice(0, 7), [null, null, null, null, null, null, null]);
  assert.equal(r[7], 4.5);
  assert.equal(r[8], (4.5 * 7 + 16) / 8);
  assert.deepEqual(rma([1, 2], 8), [null, null]);
});

test("blocks are epoch-aligned (floor(t / 3h)), OHLC from first/last candle, forming block excluded", () => {
  const start = 1_000 * 3 * H; // a block boundary
  const candles = hourly(start + H, [10, 11, 12, 13, 14]); // starts mid-block
  const { completed, forming } = buildBlocks(candles, H, start + 10 * H);
  // first block has 2 candles (starts mid-block) -> incomplete, excluded
  assert.deepEqual(completed.map((b) => [b.id, b.count, b.open, b.close]), [[1_001, 3, 11, 14]]);
  assert.equal(forming, null, "last block complete once its end has passed");
});

test("a block isn't complete until wall-clock passes its end, even with all its candles", () => {
  const start = 2_000 * 3 * H;
  const candles = hourly(start, [1, 2, 3]);
  assert.equal(buildBlocks(candles, H, start + 3 * H - 1).completed.length, 0);
  assert.equal(buildBlocks(candles, H, start + 3 * H).completed.length, 1);
});

test("Delay=1: the ribbon is a step line holding the previous completed block's values", () => {
  const start = 3_000 * 3 * H;
  const closes = Array.from({ length: 3 * 12 }, (_, i) => 100 + Math.sin(i / 3) * 10);
  const res = computeSmc(hourly(start, closes), "1H", start + 36 * H);
  // RMA(8) is first defined at completed block 7 (ends at 24h); Delay=1 shows it from block 8's first candle
  assert.equal(res.ribbon[0].time, start + 8 * 3 * H);
  // constant within each block
  for (let b = 8; b < 12; b++) {
    const inBlock = res.ribbon.filter((p) => Math.floor((p.time - start) / (3 * H)) === b);
    assert.ok(inBlock.every((p) => p.close === inBlock[0].close && p.open === inBlock[0].open));
  }
});

test("flip labels print on the first candle of the block where the visible state changes", () => {
  const start = 4_000 * 3 * H;
  // 10 falling blocks (bear), then sharply rising blocks (bull)
  const closes = [...Array.from({ length: 30 }, (_, i) => 200 - i), ...Array.from({ length: 30 }, (_, i) => 170 + i * 4)];
  const res = computeSmc(hourly(start, closes), "1H", start + 60 * H);
  assert.ok(res.flips.length >= 1);
  for (const f of res.flips) assert.equal((f.time - start) % (3 * H), 0, "labels land on block starts");
  assert.equal(res.flips.at(-1)!.side, "BUY");
  assert.equal(res.state!.bull, true);
});

test("trigger price is exact: closing just above it flips to BUY, just below does not", () => {
  const start = 5_000 * 3 * H;
  const bearish = Array.from({ length: 30 }, (_, i) => 200 - i * 1.5); // 10 falling blocks -> bear
  const formingStart = start + 30 * H;
  const base = hourly(start, bearish);
  const firstFormingCandle: Candle = { t: formingStart, o: bearish.at(-1)!, h: bearish.at(-1)!, l: bearish.at(-1)!, c: bearish.at(-1)! };
  const now = formingStart + 30; // forming block just started
  const res = computeSmc([...base, firstFormingCandle], "1H", now);
  assert.equal(res.state!.bull, false);
  const t = res.trigger!;
  assert.equal(t.flipTo, "BUY");
  assert.equal(t.flipIfClose, "above");

  const finish = (closeAt: number) => {
    const cs: Candle[] = [firstFormingCandle, { t: formingStart + H, o: firstFormingCandle.c, h: 999, l: 1, c: firstFormingCandle.c }, { t: formingStart + 2 * H, o: firstFormingCandle.c, h: 999, l: 1, c: closeAt }];
    const next: Candle = { t: formingStart + 3 * H, o: closeAt, h: closeAt, l: closeAt, c: closeAt };
    return computeSmc([...base, ...cs, next], "1H", formingStart + 3 * H + 30);
  };
  const above = finish(t.price + 0.01);
  assert.equal(above.flips.at(-1)?.side, "BUY");
  assert.equal(above.flips.at(-1)?.time, formingStart + 3 * H, "the label prints on the next block's first candle");
  const below = finish(t.price - 0.01);
  assert.notEqual(below.flips.at(-1)?.time, formingStart + 3 * H, "no flip when the block closes below the trigger");
});

test("no repainting: candles arriving inside the forming block don't change the ribbon or labels", () => {
  const start = 6_000 * 3 * H;
  const closes = Array.from({ length: 33 }, (_, i) => 100 + Math.cos(i / 2) * 8);
  const early = computeSmc(hourly(start, closes.slice(0, 31)), "1H", start + 31 * H - 1);
  const later = computeSmc(hourly(start, closes.slice(0, 32)), "1H", start + 32 * H - 1);
  const upTo = (r: typeof early) => r.ribbon.filter((p) => p.time < start + 30 * H);
  assert.deepEqual(upTo(later), upTo(early));
  assert.deepEqual(later.flips.filter((f) => f.time < start + 30 * H), early.flips.filter((f) => f.time < start + 30 * H));
});

test("triggerPrice formula", () => {
  assert.equal(triggerPrice(100, 102, 99), 99 + 7 * 2);
});
