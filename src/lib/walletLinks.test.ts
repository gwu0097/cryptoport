import test from "node:test";
import assert from "node:assert/strict";
import { summarizeLinks, type LinkTransfer } from "./walletLinks.ts";

const KNOWN = "0x058FBB1AE85D98E871AC517E523CF913A952E457";
const NEW = "0x6914b262d940b4bd8c987551569c1153d456dbd2";
const OTHER = "0x1111111111111111111111111111111111111111";
const t = (txId: string, from: string, to: string, at: string, asset = "AURORA"): LinkTransfer => ({ chain: "eth", from, to, asset, value: 1, at, txId });

test("money both ways, three times: strong", () => {
  const e = summarizeLinks([t("a", KNOWN, NEW, "2026-09-20"), t("b", NEW, KNOWN, "2026-09-22", "USDC"), t("c", KNOWN, NEW, "2026-09-28")], [KNOWN], NEW, "now");
  assert.equal(e.strength, "strong");
  assert.equal(e.toSuggested, 2);
  assert.equal(e.fromSuggested, 1);
  assert.deepEqual(e.assets, ["AURORA", "USDC"]);
  assert.equal(e.first, "2026-09-20");
  assert.equal(e.examples[0].txId, "c");
});

test("only transfers into the suggested wallet: one-way (anyone can send tokens anywhere)", () => {
  const e = summarizeLinks([t("a", KNOWN, NEW, "2026-09-20"), t("b", KNOWN, NEW, "2026-09-21"), t("c", KNOWN, NEW, "2026-09-22")], [KNOWN], NEW, "now");
  assert.equal(e.strength, "one-way");
});

test("transfers with strangers don't count; case doesn't matter; a transfer counted once", () => {
  const e = summarizeLinks([t("a", OTHER, NEW, "2026-09-20"), t("b", NEW, OTHER, "2026-09-21"), t("c", KNOWN.toLowerCase(), NEW, "x"), t("c", KNOWN, NEW, "x")], [KNOWN], NEW, "now");
  assert.equal(e.toSuggested, 1);
  assert.equal(e.fromSuggested, 0);
  assert.equal(summarizeLinks([t("a", OTHER, NEW, "x")], [KNOWN], NEW, "now").strength, "none");
});
