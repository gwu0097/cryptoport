import test from "node:test";
import assert from "node:assert/strict";
import { chartGridDate } from "./chartGrid.ts";

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test("a 00:00 grid: a point jittered to 23:59 belongs to the NEXT day's step, not the previous calendar date", () => {
  const start = at("2023-12-20T00:00:00Z");
  // The real timestamps DefiLlama returned for this grid (live, 2026-09-23).
  const got = ["2023-12-23T23:59:00Z", "2023-12-24T23:59:00Z", "2023-12-26T00:00:00Z", "2023-12-26T23:59:00Z"].map((t) => chartGridDate(at(t), start));
  assert.deepEqual(got, ["2023-12-24", "2023-12-25", "2023-12-26", "2023-12-27"], "one distinct date per point, none dropped");
});

test("a grid away from midnight labels exactly as the calendar date did (backfill unchanged)", () => {
  const start = at("2025-09-22T21:31:00Z");
  for (const t of ["2025-10-01T21:30:00Z", "2025-10-01T21:32:30Z"]) assert.equal(chartGridDate(at(t), start), "2025-10-01");
});
