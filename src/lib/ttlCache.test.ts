import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "./ttlCache.ts";

test("within the TTL a key is fetched once and carries its real fetch time; after it, refetched", async () => {
  let t = 1_000;
  let calls = 0;
  const c = createTtlCache<string>(60_000, 10, () => t);
  const load = async () => `v${++calls}`;
  const a = await c.get("k", load);
  t += 59_000;
  const b = await c.get("k", load);
  assert.equal(calls, 1);
  assert.deepEqual(b, { value: "v1", fetchedAtMs: 1_000 }, "the cached value keeps its ORIGINAL fetch time");
  assert.equal(a, b);
  t += 1_000; // 60s old
  const d = await c.get("k", load);
  assert.equal(calls, 2);
  assert.deepEqual(d, { value: "v2", fetchedAtMs: 61_000 });
});

test("identical concurrent requests share one fetch", async () => {
  let calls = 0;
  const c = createTtlCache<number>(60_000);
  let release!: (n: number) => void;
  const load = () => {
    calls++;
    return new Promise<number>((r) => (release = r));
  };
  const p1 = c.get("k", load);
  const p2 = c.get("k", load);
  release(7);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.equal(r1.value, 7);
  assert.equal(r2, r1);
});

test("failures are never cached", async () => {
  let calls = 0;
  const c = createTtlCache<number>(60_000);
  await assert.rejects(
    c.get("k", async () => {
      calls++;
      throw new Error("HTTP 429");
    }),
  );
  const ok = await c.get("k", async () => {
    calls++;
    return 1;
  });
  assert.equal(calls, 2);
  assert.equal(ok.value, 1);
});

test("bounded: the oldest entries are evicted", async () => {
  const c = createTtlCache<number>(60_000, 2);
  for (const k of ["a", "b", "c"]) await c.get(k, async () => 1);
  assert.equal(c.size(), 2);
});
