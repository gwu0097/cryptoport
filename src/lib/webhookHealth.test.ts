import { test } from "node:test";
import assert from "node:assert/strict";
import { webhookProblems } from "./webhookHealth.ts";

test("a disabled webhook is named with its reason", () => {
  assert.deepEqual(webhookProblems([{ provider: "Helius", active: false, reason: "auto-disabled: 96.1% failure rate over 24h" }]), [
    "Helius webhook is OFF (auto-disabled: 96.1% failure rate over 24h) — no live trades or alerts until it's re-enabled in the Helius dashboard",
  ]);
});

test("Alchemy names the network; active ones and unknown ones are not problems", () => {
  const lines = webhookProblems([
    { provider: "Alchemy", network: "ETH_MAINNET", active: true, reason: "UNKNOWN" },
    { provider: "Alchemy", network: "ROBINHOOD_MAINNET", active: false, reason: "TOO_MANY_ERRORS" },
    { provider: "Helius", active: undefined },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Alchemy ROBINHOOD_MAINNET webhook is OFF \(TOO_MANY_ERRORS\)/);
});

test("all delivering: nothing to report", () => {
  assert.deepEqual(webhookProblems([{ provider: "Helius", active: true }]), []);
});
