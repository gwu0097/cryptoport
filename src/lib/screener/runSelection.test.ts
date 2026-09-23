import test from "node:test";
import assert from "node:assert/strict";
import { pickRunPerUtcDay, latestDailyRun } from "./runSelection.ts";

const run = (id: string, started_at: string, status = "ok", kind = "live") => ({ id, started_at, status, kind });

test("a day with several ok live runs is represented by its latest", () => {
  const days = pickRunPerUtcDay([
    run("early", "2026-09-22T21:24:05Z"),
    run("late", "2026-09-22T23:28:56Z"),
    run("mid", "2026-09-22T23:04:49Z"),
    run("next", "2026-09-23T07:58:43Z"),
  ]);
  assert.equal(days.get("2026-09-22")!.id, "late");
  assert.equal(days.get("2026-09-23")!.id, "next");
  assert.equal(days.size, 2);
});

test("error, running, partial and backfill runs never represent a day — even when later", () => {
  const days = pickRunPerUtcDay([
    run("ok", "2026-09-23T07:58:00Z"),
    run("err", "2026-09-23T08:10:00Z", "error"),
    run("running", "2026-09-23T09:00:00Z", "running"),
    run("partial", "2026-09-23T10:00:00Z", "partial"),
    run("backfill", "2026-09-23T11:00:00Z", "ok", "backfill"),
  ]);
  assert.equal(days.get("2026-09-23")!.id, "ok");
});

test("days are UTC days, whatever the timestamp's offset", () => {
  // 23:30 at -07:00 is 06:30 UTC the NEXT day.
  const days = pickRunPerUtcDay([run("a", "2026-09-22T23:30:00-07:00")]);
  assert.ok(days.has("2026-09-23"));
});

test("latestDailyRun: the most recent day's run, or null with no ok live run", () => {
  assert.equal(latestDailyRun([run("a", "2026-09-22T23:00:00Z"), run("b", "2026-09-23T07:58:00Z")])!.id, "b");
  assert.equal(latestDailyRun([run("x", "2026-09-23T07:58:00Z", "error")]), null);
  assert.equal(latestDailyRun([]), null);
});
