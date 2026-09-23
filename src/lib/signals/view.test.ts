import test from "node:test";
import assert from "node:assert/strict";
import { barCloseView, dropImportedRun, smcView } from "./view.ts";
import { rulesFor } from "./rules.ts";
import { rngFor } from "./harness.ts";
import type { Candle } from "../smc/engine.ts";

const H = 3600;
function series(seed: string, n: number, drift: number, vol: number): Candle[] {
  const r = rngFor(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + drift + (r() - 0.5) * vol;
    return { t: i * H, o: p, h: p * (1 + (r() * vol) / 2), l: p * (1 - (r() * vol) / 2), c: p };
  });
}
const fmt = (n: number) => n.toFixed(2);
const IDS = ["rsi2", "bb", "ma", "donchian"] as const;

test("bar-close state machine: alternating Buy/Sell, each on a bar where the rule fired, and nothing skipped", () => {
  for (const id of IDS) {
    let total = 0;
    for (let s = 0; s < 8; s++) {
      const cs = series(`${id}${s}`, 500, 0.001, 0.03);
      const now = cs.length * H + 60; // the last candle is completed; nothing forming
      const v = barCloseView(id, cs, "1H", now, fmt);
      const rules = rulesFor(id, cs, "1H", now);
      const idx = new Map(cs.map((c, i) => [c.t, i]));
      // Replay independently: Flat → Buy on the first entry bar; Long → Sell on
      // the first later exit bar (never the entry bar itself).
      const expected: { side: string; i: number }[] = [];
      let long = false;
      for (let i = rules.warmup; i < cs.length; i++) {
        if (!long && rules.entry[i]) {
          expected.push({ side: "BUY", i });
          long = true;
        } else if (long && rules.exit[i] && expected.at(-1)!.i < i) {
          expected.push({ side: "SELL", i });
          long = false;
        }
      }
      assert.deepEqual(
        v.signals.map((m) => ({ side: m.side, i: idx.get(m.barTime)! })),
        expected,
        `${id} seed ${s}`,
      );
      assert.equal(v.state?.label, long ? "Long" : "Flat", `${id} seed ${s} state`);
      total += expected.length;
      // The trigger is the rule that would CHANGE the state.
      if (v.trigger) assert.equal(v.trigger.side, long ? "SELL" : "BUY");
      for (const m of v.signals) {
        assert.equal(m.time, m.barTime + H, "decided at that bar's close");
        assert.equal(m.price, cs[idx.get(m.barTime)!].c);
      }
    }
    assert.ok(total >= 10, `${id}: enough signals exercised (${total})`);
  }
});

test("a signal decided on the LAST completed bar is shown (not dropped for lack of a fill bar)", () => {
  // Rising then one sharp drop on the final bar: RSI(2) entry fires there.
  const cs = series("up", 260, 0.003, 0.004);
  const last = cs[cs.length - 1];
  cs[cs.length - 1] = { ...last, c: cs[cs.length - 2].c * 0.97, l: cs[cs.length - 2].c * 0.97 };
  const now = cs.length * H + 1;
  assert.equal(rulesFor("rsi2", cs, "1H", now).entry.at(-1), true, "fixture: entry fires on the last bar");
  const v = barCloseView("rsi2", cs, "1H", now, fmt);
  assert.equal(v.signals.at(-1)?.barTime, cs[cs.length - 1].t);
  assert.equal(v.state?.label, "Long");
});

test("the forming candle is never evaluated, and decidedAt is its close", () => {
  const cs = series("forming", 300, 0.001, 0.03);
  const now = (cs.length - 1) * H + 100; // last candle still forming
  const v = barCloseView("donchian", cs, "1H", now, fmt);
  const w = barCloseView("donchian", cs.slice(0, -1), "1H", now, fmt);
  assert.deepEqual(v.signals, w.signals);
  assert.deepEqual(v.trigger, w.trigger);
  assert.equal(v.decidedAt, cs.length * H);
  assert.ok(v.overlays.every((o) => o.points.every((p) => p.time < cs[cs.length - 1].t)));
});

test("Hyperliquid's leading n = 0 imported run is dropped; a mid-series n = 0 candle is kept", () => {
  const cs = series("n", 10, 0, 0.02).map((c, i) => ({ ...c, n: i < 3 || i === 6 ? 0 : 5 }));
  const kept = dropImportedRun(cs);
  assert.equal(kept.length, 7);
  assert.equal(kept[0].t, cs[3].t);
  assert.ok(kept.some((c) => c.t === cs[6].t));
});

test("not enough venue history → state null (unknown), never a guess", () => {
  const cs = series("short", 150, 0.001, 0.02); // SMA(200) never defined
  const v = barCloseView("rsi2", cs, "1H", cs.length * H + 1, fmt);
  assert.equal(v.state, null);
  assert.equal(v.trigger, null);
  assert.deepEqual(v.signals, []);
});

test("SMC view mirrors its engine's state and trigger", () => {
  const cs = series("smc", 400, 0.001, 0.03);
  const now = (cs.length - 1) * H + 10;
  const v = smcView(cs, "1H", now);
  assert.ok(v.state);
  assert.equal(v.closeUnit, "3H block");
  if (v.trigger?.kind === "price") assert.equal(v.trigger.side, v.state!.up ? "SELL" : "BUY");
});
