import test from "node:test";
import assert from "node:assert/strict";
import { isAdminEmail } from "./adminEmail.ts";

test("isAdminEmail matches an exact email", () => {
  assert.equal(isAdminEmail("thunderclapper3@gmail.com", "thunderclapper3@gmail.com"), true);
});

test("isAdminEmail matches case-insensitively", () => {
  assert.equal(isAdminEmail("Thunderclapper3@Gmail.com", "thunderclapper3@gmail.com"), true);
  assert.equal(isAdminEmail("thunderclapper3@gmail.com", "THUNDERCLAPPER3@GMAIL.COM"), true);
});

test("isAdminEmail rejects a real, different email", () => {
  assert.equal(isAdminEmail("someone-else@gmail.com", "thunderclapper3@gmail.com"), false);
});

test("isAdminEmail fails closed when the signed-in user has no email", () => {
  assert.equal(isAdminEmail(null, "thunderclapper3@gmail.com"), false);
  assert.equal(isAdminEmail(undefined, "thunderclapper3@gmail.com"), false);
  assert.equal(isAdminEmail("", "thunderclapper3@gmail.com"), false);
});

test("isAdminEmail fails closed when ADMIN_EMAIL is unset — the feature-disabled state", () => {
  assert.equal(isAdminEmail("thunderclapper3@gmail.com", undefined), false);
  assert.equal(isAdminEmail("thunderclapper3@gmail.com", ""), false);
});
