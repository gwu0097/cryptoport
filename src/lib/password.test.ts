import test from "node:test";
import assert from "node:assert/strict";
import { validatePassword, MIN_PASSWORD_LENGTH } from "./password.ts";

test("validatePassword rejects a password shorter than the minimum", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  assert.match(validatePassword(short, short) ?? "", /at least/);
});

test("validatePassword accepts a password exactly at the minimum length, matching its confirmation", () => {
  const exact = "a".repeat(MIN_PASSWORD_LENGTH);
  assert.equal(validatePassword(exact, exact), null);
});

test("validatePassword rejects a mismatched confirmation", () => {
  const password = "a".repeat(MIN_PASSWORD_LENGTH);
  assert.match(validatePassword(password, password + "x") ?? "", /match/);
});

test("validatePassword checks length before match", () => {
  // A too-short password that also doesn't match its confirmation should
  // report the length problem, not the mismatch — same order every call
  // site now shares.
  assert.match(validatePassword("short", "different") ?? "", /at least/);
});
