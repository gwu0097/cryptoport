import test from "node:test";
import assert from "node:assert/strict";
import { dropTradableReceiptPositions, dropUntradableReceiptTokens, isTradable, receiptKey } from "./receiptDedupe.ts";

const MATICX = "0xFa68FB4628DFF1028CFEc22b4162FCcd0d45efb6";
const MDEGEN = "0x8c3a6b12332a6354805eb4b72ef619aedd22bcdd";
const volume = new Map<string, number | null>([["stader-maticx", 250_000], ["morpho-degen", 0]]);

test("tradable: at or above the volume floor; unlisted or no volume is not", () => {
  assert.equal(isTradable(250_000), true);
  assert.equal(isTradable(0), false);
  assert.equal(isTradable(null), false);
  assert.equal(isTradable(undefined), false);
});

test("DeFi sync drops a position only when its receipt is held and tradable", () => {
  const held = new Map([
    [receiptKey("matic", MATICX), "stader-maticx"],
    [receiptKey("base", MDEGEN), "morpho-degen"],
  ]);
  const positions = [
    { name: "Stader", chain: "matic", pool_contract: MATICX.toLowerCase() },
    { name: "Morpho", chain: "base", pool_contract: MDEGEN },
    { name: "Aave", chain: "avax", pool_contract: "0xaavepool" }, // pool isn't a held token
    { name: "no pool", chain: "base", pool_contract: null },
  ];
  assert.deepEqual(dropTradableReceiptPositions(positions, held, volume).map((p) => p.name), ["Morpho", "Aave", "no pool"]);
});

test("wallet sync drops a held receipt only when it isn't tradable", () => {
  const pools = new Set([receiptKey("matic", MATICX), receiptKey("base", MDEGEN)]);
  const tokens = [
    { t: "MaticX", chain: "matic", contract: MATICX, price_key: "stader-maticx" },
    { t: "mDEGEN", chain: "base", contract: MDEGEN, price_key: "morpho-degen" },
    { t: "unlisted receipt", chain: "base", contract: MDEGEN, price_key: null },
    { t: "ETH", chain: "base", contract: null, price_key: "ethereum" },
    { t: "same contract, other chain", chain: "arb", contract: MDEGEN, price_key: "morpho-degen" },
  ];
  assert.deepEqual(dropUntradableReceiptTokens(tokens, pools, volume).map((x) => x.t), ["MaticX", "ETH", "same contract, other chain"]);
});
