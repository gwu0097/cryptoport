import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { authPayload, balancesToHoldings, priceKeyFor, base58, erc191Signature, readAuthPayload, timestampedBytes, versionedNonce } from "./nearIntents.ts";

test("the nonce matches intents.near's own example byte for byte (docs, 2025-05-21: its deadline in bytes 9–16)", () => {
  const example = "Vij2xgAlKBKzgNPJFViEQRgYyS7p2NEiYTTY4XmT8go=";
  const tail = Uint8Array.from(atob(example), (c) => c.charCodeAt(0)).slice(17);
  assert.equal(versionedNonce("252812b3", Date.parse("2025-05-21T10:34:04.254Z"), tail), example);
});

test("the inner bytes start with the time the nonce was made (the server's 5-minute check)", () => {
  const inner = timestampedBytes(Date.parse("2026-10-08T00:00:00Z"), new Uint8Array(7).fill(9));
  const ns = new DataView(inner.buffer).getBigUint64(0, true);
  assert.equal(ns, BigInt(Date.parse("2026-10-08T00:00:00Z")) * BigInt(1_000_000));
  assert.deepEqual([...inner.slice(8)], [9, 9, 9, 9, 9, 9, 9]);
});

test("base58 matches the standard test vector", () => {
  assert.equal(base58(new TextEncoder().encode("Hello World!")), "2NEpo7TZRRrLZSi2U");
  assert.equal(base58(Uint8Array.from([0, 0, 1])), "112");
});

test("a MetaMask signature becomes secp256k1:base58 with the recovery byte 0/1, and still recovers the signer", async () => {
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const payload = authPayload(account.address, "nonce", new Date("2026-10-08T00:00:00Z"));
  const sig = await account.signMessage({ message: payload });
  const encoded = erc191Signature(sig);
  assert.match(encoded, /^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/);
  // Decode it back and check the last byte is 0/1 and the signature still verifies.
  const b58 = encoded.slice("secp256k1:".length);
  let n = BigInt(0);
  for (const c of b58) n = n * BigInt(58) + BigInt("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(c));
  const hex = n.toString(16).padStart(130, "0");
  const v = parseInt(hex.slice(128), 16);
  assert.ok(v === 0 || v === 1);
  const recovered = await recoverMessageAddress({ message: payload, signature: `0x${hex.slice(0, 128)}${(v + 27).toString(16)}` });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test("the signed payload is the empty ownership proof, keys in the documented order", () => {
  const p = authPayload("0xAbC0000000000000000000000000000000000001", "N", new Date("2026-10-08T00:00:00Z"));
  assert.equal(p, '{"signer_id":"0xabc0000000000000000000000000000000000001","verifying_contract":"intents.near","deadline":"2026-10-08T00:00:00.000Z","nonce":"N","intents":[]}');
  assert.deepEqual(readAuthPayload(p), { signerId: "0xabc0000000000000000000000000000000000001", deadline: new Date("2026-10-08T00:00:00Z") });
});

test("the server refuses to forward anything but an empty intent for intents.near", () => {
  const ok = JSON.parse(authPayload("0xabc0000000000000000000000000000000000001", "N", new Date()));
  const variants = [
    { ...ok, intents: [{ intent: "transfer", receiver_id: "x.near", tokens: { "nep141:usdc.near": "1" } }] },
    { ...ok, verifying_contract: "evil.near" },
    { ...ok, signer_id: "x.near" },
    { extra: 1, ...ok },
  ];
  for (const v of variants) assert.equal(readAuthPayload(JSON.stringify(v)), null);
  assert.equal(readAuthPayload("not json"), null);
});

test("balances become holdings named and priced by the token list; an unknown token is kept, unpriced, and named", () => {
  const tokens = [{ assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", decimals: 6, blockchain: "arb", coingeckoId: "usd-coin" }];
  const { holdings, warnings } = balancesToHoldings(
    [
      { tokenId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", available: "10000000", source: "private" },
      { tokenId: "nep141:mystery.near", available: "5", source: "private" },
      { tokenId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", available: "0" },
    ],
    tokens,
  );
  assert.equal(holdings.length, 2);
  assert.deepEqual({ t: holdings[0].ticker, q: holdings[0].qty, cg: holdings[0].coingecko_id, chain: holdings[0].chain, label: holdings[0].display_label }, { t: "USDC", q: 10, cg: "usd-coin", chain: "nearcom", label: "USDC (arb)" });
  assert.equal(holdings[1].coingecko_id, null);
  assert.match(warnings[0], /1 token not in near\.com's token list/);
  // An already-formatted amount (a decimal point) is taken as is.
  assert.equal(balancesToHoldings([{ tokenId: tokens[0].assetId, available: "10.5" }], tokens).holdings[0].qty, 10.5);
});

test("a token near.com names with its own id ('custom:qtc') is priced from near.com, not as a CoinGecko id", () => {
  assert.equal(priceKeyFor({ assetId: "nep141:arb-0xaf88.omft.near", coingeckoId: "usd-coin" }), "usd-coin");
  assert.equal(priceKeyFor({ assetId: "nep141:qtc.omft.near", coingeckoId: "custom:qtc" }), "nearcom:nep141:qtc.omft.near");
  assert.equal(priceKeyFor({ assetId: "nep141:x.near", coingeckoId: null }), "nearcom:nep141:x.near");
});
