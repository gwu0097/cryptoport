import test from "node:test";
import assert from "node:assert/strict";
import { applyFetch, candlesFrom, isFresh, planFetch, SETTLE_SEC, type CandleEntry } from "./candleCache.ts";
import type { Candle } from "./engine.ts";

const H = 3600;

/** A fake Hyperliquid: deterministic candles; the one containing `nowSec` is
 * still forming (its close/high/low depend on how far into the bar we are). */
function api(fromSec: number, nowSec: number): Candle[] {
  const out: Candle[] = [];
  for (let t = Math.floor(fromSec / H) * H; t <= nowSec; t += H) {
    const o = 100 + Math.sin(t / 7919) * 10;
    const done = t + H <= nowSec;
    const frac = done ? 1 : (nowSec - t) / H;
    const c = o + Math.cos(t / 3571) * 3 * frac;
    out.push({ t, o, h: Math.max(o, c) + frac, l: Math.min(o, c) - frac, c, n: 5 });
  }
  return out;
}

function load(e: CandleEntry | undefined, wantFrom: number, now: number): { e: CandleEntry; calls: number } {
  const plan = planFetch(e, wantFrom, now);
  if (plan.kind === "hit") return { e: e!, calls: 0 };
  return { e: applyFetch(e, plan, api(plan.fromSec, now), H, now), calls: 1 };
}

test("within one bar the cache is a hit; after a close it fetches only from the last completed candle", () => {
  const t0 = 1_000 * H + 1200; // 20 min into a bar
  const want = t0 - 600 * H;
  let { e, calls } = load(undefined, want, t0);
  assert.equal(calls, 1);
  ({ e, calls } = load(e, want, t0 + 1500)); // same bar
  assert.equal(calls, 0);
  const plan = planFetch(e, want, t0 + 2400 + 60); // next bar
  assert.deepEqual(plan, { kind: "incremental", fromSec: e.completed.at(-1)!.t });
});

test("EXACT: incremental updates across many bar closes equal a fresh full fetch", () => {
  const start = 2_000 * H + 900;
  const want0 = start - 600 * H;
  let e: CandleEntry | undefined;
  let calls = 0;
  for (let k = 0; k < 40; k++) {
    const now = start + k * 1700; // loads at irregular times, some within a bar, some across closes
    const r = load(e, want0, now);
    e = r.e;
    calls += r.calls;
    const fresh = applyFetch(undefined, { kind: "full", fromSec: want0 }, api(want0, now), H, now);
    // Completed candles must match exactly. (Within a hit, the forming candle is
    // as of the earlier fetch — only its open is relied on, and that is fixed.)
    assert.deepEqual(e.completed, fresh.completed, `load ${k}`);
    assert.equal(e.forming?.t, fresh.forming?.t);
    assert.equal(e.forming?.o, fresh.forming?.o);
  }
  assert.ok(calls < 40, `some loads were cache hits (${calls} fetches for 40 loads)`);
});

test("a fetch right after a close isn't trusted for the rest of the bar (the last candle may not be final)", () => {
  const open = 3_000 * H;
  const e = applyFetch(undefined, { kind: "full", fromSec: open - 100 * H }, api(open - 100 * H, open + 5), H, open + 5);
  assert.equal(isFresh(e, open + 30), false);
  assert.deepEqual(planFetch(e, open - 100 * H, open + 30), { kind: "incremental", fromSec: open - H });
  const e2 = applyFetch(e, { kind: "incremental", fromSec: open - H }, api(open - H, open + SETTLE_SEC), H, open + SETTLE_SEC);
  assert.equal(isFresh(e2, open + 1000), true);
});

test("a longer window than cached triggers a full fetch; a shorter one is served from the same entry", () => {
  const now = 4_000 * H + 600;
  const e = applyFetch(undefined, { kind: "full", fromSec: now - 600 * H }, api(now - 600 * H, now), H, now);
  assert.equal(planFetch(e, now - 1440 * H, now + 60).kind, "full");
  assert.equal(planFetch(e, now - 300 * H, now + 60).kind, "hit");
  const cs = candlesFrom(e, now - 300 * H);
  assert.ok(cs[0].t >= now - 300 * H);
  assert.equal(cs.at(-1)!.t, 4_000 * H, "ends with the forming candle");
});
