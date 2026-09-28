import test from "node:test";
import assert from "node:assert/strict";
import { fetchDelay, IDLE_GAP_MS, isWatching, minutesLeft, WATCH_FOR_MS, WATCHING_GAP_MS, WATCHING_SETTLE_MS } from "./liveWatching.ts";

const T = 1_800_000_000_000;

test("watching: a lone trade comes in a second later; a burst at most every 15 s", () => {
  assert.equal(fetchDelay(T - 10 * 60_000, T, true), WATCHING_SETTLE_MS);
  assert.equal(fetchDelay(T - 5_000, T, true), WATCHING_GAP_MS - 5_000);
});

test("not watching: at most every 30 minutes, at once when the last fetch is older", () => {
  assert.equal(fetchDelay(T - 60_000, T, false), IDLE_GAP_MS - 60_000);
  assert.equal(fetchDelay(T - IDLE_GAP_MS - 1, T, false), 0);
});

test("watching ends after an hour", () => {
  const until = T + WATCH_FOR_MS;
  assert.equal(isWatching(until, T + WATCH_FOR_MS - 1), true);
  assert.equal(isWatching(until, until), false);
  assert.equal(isWatching(null, T), false);
  assert.equal(minutesLeft(until, T), 60);
  assert.equal(minutesLeft(until, until - 10_000), 1);
});
