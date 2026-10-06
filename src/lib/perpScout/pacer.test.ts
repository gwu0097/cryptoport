import test from "node:test";
import assert from "node:assert/strict";
import { createPacer } from "./pacer.ts";

test("pacer waits until the oldest weight leaves the minute", async () => {
  let t = 0;
  const slept: number[] = [];
  const p = createPacer(100, () => t, async (ms) => {
    slept.push(ms);
    t += ms;
  });
  await p.reserve(60);
  t = 10_000;
  await p.reserve(40);
  assert.deepEqual(slept, []);
  await p.reserve(20); // must wait for the first 60 (spent at 0) to expire at 60s
  assert.equal(t, 60_000);
  p.charge(100); // fills' extra weight, booked after the answer
  await p.reserve(1);
  assert.ok(t >= 120_000);
});
