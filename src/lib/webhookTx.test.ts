import test from "node:test";
import assert from "node:assert/strict";
import { rawTxChanges, worthSaving, type RawWebhookTx } from "./webhookTx.ts";

const OWNER = "Owner1111111111111111111111111111111111111";
const POOL = "Pool11111111111111111111111111111111111111";
const GEM = "Gem111111111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const tb = (accountIndex: number, mint: string, owner: string, amount: string, decimals = 6) => ({ accountIndex, mint, owner, uiTokenAmount: { amount, decimals } });

const buy: RawWebhookTx = {
  blockTime: 1790620579,
  meta: {
    err: null,
    fee: 55_000,
    // Owner pays 2 SOL (+ fee), a new token account is funded in the same tx.
    preBalances: [10_000_000_000, 0, 5_000_000_000],
    postBalances: [7_997_905_000, 2_039_280, 7_000_000_000],
    preTokenBalances: [tb(3, GEM, POOL, "1000000000000")],
    postTokenBalances: [tb(1, GEM, OWNER, "20808096000000"), tb(3, GEM, POOL, "979191904000000")],
  },
  transaction: { signatures: ["sigBuy"], message: { accountKeys: [OWNER, "OwnerGemAta", POOL] } },
};

test("a pump.fun-style buy: SOL out (fee added back), the gem in", () => {
  const c = rawTxChanges(buy, OWNER);
  const sol = c.find((x) => x.contract === null)!;
  const gem = c.find((x) => x.contract === GEM)!;
  assert.ok(Math.abs(sol.qty - -2.00204) < 1e-9); // 2 SOL + ATA rent, not the fee
  assert.equal(gem.qty, 20_808_096);
  assert.equal(c[0].txId, "sigBuy");
  assert.equal(c[0].at, new Date(1790620579 * 1000).toISOString());
  assert.equal(worthSaving(c), true);
});

test("wrapped SOL counts as SOL; lookup-table accounts are indexed after the message's", () => {
  const tx: RawWebhookTx = {
    blockTime: 1,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000, 0],
      postBalances: [999_995_000, 0],
      preTokenBalances: [tb(1, WSOL, OWNER, "3000000000", 9), tb(2, GEM, OWNER, "500", 0)],
      postTokenBalances: [tb(1, WSOL, OWNER, "0", 9)],
      loadedAddresses: { writable: ["Lut1"], readonly: [] },
    },
    transaction: { signatures: ["s"], message: { accountKeys: [OWNER] } },
  };
  const c = rawTxChanges(tx, OWNER);
  assert.equal(c.find((x) => x.contract === null)!.qty, -3); // wSOL unwrapped/spent, fee added back
  assert.equal(c.find((x) => x.contract === GEM)!.qty, -500);
});

test("a failed transaction and an airdrop are not worth a database read", () => {
  assert.deepEqual(rawTxChanges({ ...buy, meta: { ...buy.meta, err: { InstructionError: [0, "Custom"] } } }, OWNER), []);
  const airdrop: RawWebhookTx = {
    blockTime: 1,
    meta: { err: null, fee: 5000, preBalances: [0, 0], postBalances: [0, 0], preTokenBalances: [], postTokenBalances: [tb(1, GEM, OWNER, "1000000")] },
    transaction: { signatures: ["a"], message: { accountKeys: ["Spammer", OWNER] } },
  };
  const c = rawTxChanges(airdrop, OWNER);
  assert.equal(c.length, 1);
  assert.equal(worthSaving(c), false);
});

test("a token sent to another wallet names its counterparty", () => {
  const tx: RawWebhookTx = {
    blockTime: 1,
    meta: { err: null, fee: 5000, preBalances: [0], postBalances: [0], preTokenBalances: [tb(1, GEM, OWNER, "900"), tb(2, GEM, "Friend", "0")], postTokenBalances: [tb(1, GEM, OWNER, "400"), tb(2, GEM, "Friend", "500")] },
    transaction: { signatures: ["t"], message: { accountKeys: [OWNER] } },
  };
  const gem = rawTxChanges(tx, OWNER).find((x) => x.contract === GEM)!;
  assert.equal(gem.counterparty, "Friend");
  assert.equal(gem.qty, -0.0005);
});
