import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAddressInput, evmAddressProblem } from "./addressInput.ts";

const ADDR = "0xdde33d0a8a7386b7f1d3243a55831f0bf668904e";

test("a chain prefix (EIP-3770, Hyperliquid's HL:) is removed from an EVM address", () => {
  assert.equal(cleanAddressInput(`HL:${ADDR}`), ADDR);
  assert.equal(cleanAddressInput(`  eth:${ADDR} `), ADDR);
  assert.equal(cleanAddressInput(`arb1:${ADDR}`), ADDR);
});

test("anything else is only trimmed", () => {
  assert.equal(cleanAddressInput(` ${ADDR} `), ADDR);
  assert.equal(cleanAddressInput("4a7NWcurNg4ynBk2U8ujhHW2evCjp3LmEkeEHsiPDCTs"), "4a7NWcurNg4ynBk2U8ujhHW2evCjp3LmEkeEHsiPDCTs");
  assert.equal(cleanAddressInput("bitcoin:bc1qxyz"), "bitcoin:bc1qxyz");
});

test("an EVM wallet must have a real 0x address", () => {
  assert.equal(evmAddressProblem(ADDR), null);
  assert.match(evmAddressProblem(`HL:${ADDR}`)!, /isn't an EVM address/);
  assert.match(evmAddressProblem("0x123")!, /isn't an EVM address/);
  assert.match(evmAddressProblem(null)!, /needs an address/);
});
