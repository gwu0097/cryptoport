import test from "node:test";
import assert from "node:assert/strict";
import { bech32 } from "@scure/base";
import { toBech32Address } from "./cosmosAddress.ts";

// A fixed, non-user test key: 20 bytes 0x00..0x13.
const HEX = "0x000102030405060708090a0b0c0d0e0f10111213";
const bytes = Uint8Array.from({ length: 20 }, (_, i) => i);
const INJ = bech32.encode("inj", bech32.toWords(bytes));

test("a 0x address on a hex-account chain becomes the same 20 bytes in bech32", () => {
  assert.equal(toBech32Address(HEX, "inj", true), INJ);
  assert.equal(toBech32Address(HEX.toUpperCase().replace("0X", "0x"), "inj", true), INJ, "checksum/uppercase hex too");
  assert.deepEqual(Uint8Array.from(bech32.fromWords(bech32.decode(INJ as `${string}1${string}`).words)), bytes, "round-trips");
});

test("an address already in the chain's bech32 form passes through unchanged", () => {
  assert.equal(toBech32Address(INJ, "inj", true), INJ);
  assert.equal(toBech32Address(`  ${INJ}  `, "inj", true), INJ);
});

test("wrong prefix, non-hex-account chains and garbage get a clear error, not an API 400", () => {
  const cosmos = bech32.encode("cosmos", bech32.toWords(bytes));
  assert.throws(() => toBech32Address(cosmos, "inj", true), /Not a valid inj address/);
  assert.throws(() => toBech32Address(HEX, "cosmos", false), /expected cosmos1…$/);
  assert.throws(() => toBech32Address("0x1234", "inj", true), /Not a valid inj address/);
});
