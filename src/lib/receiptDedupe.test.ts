import test from "node:test";
import assert from "node:assert/strict";
import { dedupeReceipts, linkVaultPositions, dropTradableReceiptPositions, dropUntradableReceiptTokens, isTradable, receiptKey } from "./receiptDedupe.ts";

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

test("one sync's fresh lists: every receipt is counted exactly once", () => {
  const EETH = "0x35fa164735182de50811e8e2e824cfb9b6118ac2";
  const vol = new Map<string, number | null>([["stader-maticx", 1_051], ["ether-fi-staked-eth", 9_281_471]]);
  const tokens = [
    { t: "MaticX", chain: "matic", contract: MATICX, price_key: "stader-maticx" },
    { t: "eETH", chain: "eth", contract: EETH, price_key: "ether-fi-staked-eth" },
    { t: "ETH", chain: "eth", contract: null, price_key: "ethereum" },
  ];
  const positions = [
    { p: "Stader", chain: "matic", pool_contract: MATICX.toLowerCase() },
    { p: "ether.fi", chain: "eth", pool_contract: EETH },
    { p: "Aave", chain: "avax", pool_contract: "0xaavepool" },
  ];
  const r = dedupeReceipts(tokens, positions, vol);
  assert.deepEqual(r.tokens.map((x) => x.t), ["eETH", "ETH"]); // MaticX isn't tradable: Stader counts it
  assert.deepEqual(r.positions.map((x) => x.p), ["Stader", "Aave"]); // eETH is tradable: the token counts it
});

test("a vault position without a pool is linked to the held vault token only on an exact match", () => {
  const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
  const claim = { chain: "base", vault: MDEGEN, asset: DEGEN, assets: 32074.35 };
  const morpho = { p: "Morpho", chain: "base", contract: DEGEN, qty: 32074.3507, pool_contract: null };
  const [linked] = linkVaultPositions([morpho], [claim]);
  assert.equal(linked.pool_contract, MDEGEN);
  // then the usual rule applies: mDEGEN has no volume, so the position stays and the token goes
  const r = dedupeReceipts([{ t: "mDEGEN", chain: "base", contract: MDEGEN, price_key: "morpho-degen" }], [linked], volume);
  assert.deepEqual([r.tokens.length, r.positions.length], [0, 1]);

  const off = linkVaultPositions([{ ...morpho, qty: 30_000 }], [claim]); // amounts differ: not the same money
  assert.equal(off[0].pool_contract, null);
  const otherChain = linkVaultPositions([{ ...morpho, chain: "eth" }], [claim]);
  assert.equal(otherChain[0].pool_contract, null);
  const twoVaults = linkVaultPositions([morpho], [claim, { ...claim, vault: "0xother" }]); // ambiguous
  assert.equal(twoVaults[0].pool_contract, null);
  const twoPositions = linkVaultPositions([morpho, { ...morpho, p: "Morpho 2" }], [claim]); // one claim, two takers
  assert.deepEqual(twoPositions.map((x) => x.pool_contract), [null, null]);
});
