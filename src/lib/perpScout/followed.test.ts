import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOWED } from "./followed.ts";

test("every followed trader is a lowercase Hyperliquid address, listed once", () => {
  for (const f of FOLLOWED) assert.match(f.address, /^0x[0-9a-f]{40}$/, f.name);
  assert.equal(new Set(FOLLOWED.map((f) => f.address)).size, FOLLOWED.length);
  for (const f of FOLLOWED) assert.match(f.addedOn, /^\d{4}-\d{2}-\d{2}$/);
});
