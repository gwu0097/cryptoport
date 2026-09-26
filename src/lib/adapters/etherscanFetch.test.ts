import test from "node:test";
import assert from "node:assert/strict";
import { isRateLimited } from "./etherscanFetch.ts";

test("Etherscan's per-second limit is recognized from its 200 body; other answers aren't", () => {
  assert.equal(isRateLimited({ status: "0", message: "NOTOK", result: "Max calls per sec rate limit reached (3/sec)" }), true);
  assert.equal(isRateLimited({ status: "0", message: "No transactions found", result: [] }), false);
  assert.equal(isRateLimited({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain" }), false);
  assert.equal(isRateLimited({ status: "1", message: "OK", result: [] }), false);
});
