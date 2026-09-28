import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { alchemyChanges, validAlchemySignature, type AlchemyActivity, type AlchemyDelivery } from "./alchemyWebhookTx.ts";
import { worthSaving } from "./webhookTx.ts";

const OWNER = "0xAbC0000000000000000000000000000000000001";
const owner = OWNER.toLowerCase();
const ROUTER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const watched = new Set([owner]);
const delivery = (network: string, activity: AlchemyActivity[]): AlchemyDelivery => ({
  webhookId: "wh_1",
  createdAt: "2026-09-28T12:00:00.000Z",
  type: "ADDRESS_ACTIVITY",
  event: { network, activity },
});

test("a sale on Ethereum: the token out, the router's ETH back as an internal transfer", () => {
  const d = delivery("ETH_MAINNET", [
    { fromAddress: OWNER, toAddress: POOL, hash: "0xsell", value: 1_000_000, asset: "PEPE", category: "token", rawContract: { address: PEPE, decimals: 18 } },
    { fromAddress: ROUTER, toAddress: OWNER, hash: "0xsell", value: 2.5, asset: "ETH", category: "internal", rawContract: { address: null, decimals: 18 } },
  ]);
  const c = alchemyChanges(d, watched).get(owner)!;
  assert.equal(c.length, 2);
  const pepe = c.find((x) => x.contract === PEPE.toLowerCase())!;
  const eth = c.find((x) => x.contract === null)!;
  assert.equal(pepe.qty, -1_000_000);
  assert.equal(pepe.chain, "eth");
  assert.equal(eth.qty, 2.5);
  assert.equal(eth.symbol, "ETH");
  assert.equal(eth.at, "2026-09-28T12:00:00.000Z");
  assert.equal(worthSaving(c), true);
});

test("a buy on Arbitrum paid in ETH (external) is read on arb", () => {
  const d = delivery("ARB_MAINNET", [
    { fromAddress: OWNER, toAddress: ROUTER, hash: "0xbuy", value: 0.4, asset: "ETH", category: "external", rawContract: { address: null } },
    { fromAddress: POOL, toAddress: OWNER, hash: "0xbuy", value: null, asset: "GMX", category: "token", rawContract: { address: POOL, rawValue: "0x0de0b6b3a7640000", decimals: 18 } },
  ]);
  const c = alchemyChanges(d, watched).get(owner)!;
  assert.deepEqual(c.map((x) => [x.chain, x.contract, x.qty]), [["arb", null, -0.4], ["arb", POOL, 1]]);
});

test("an airdrop, a self-transfer, an NFT and a removed log are not worth a database read", () => {
  const d = delivery("ETH_MAINNET", [
    { fromAddress: POOL, toAddress: OWNER, hash: "0xspam", value: 5000, asset: "SCAM", category: "token", rawContract: { address: POOL } },
    { fromAddress: OWNER, toAddress: OWNER, hash: "0xself", value: 1, asset: "ETH", category: "external", rawContract: { address: null } },
    { fromAddress: OWNER, toAddress: POOL, hash: "0xnft", value: null, asset: "APE", category: "token", erc721TokenId: "0x1", rawContract: { address: POOL } },
    { fromAddress: OWNER, toAddress: POOL, hash: "0xreorg", value: 3, asset: "PEPE", category: "token", rawContract: { address: PEPE }, log: { removed: true } },
  ]);
  const c = alchemyChanges(d, watched).get(owner)!;
  assert.deepEqual(c.map((x) => x.txId), ["0xspam"]);
  assert.equal(worthSaving(c), false);
});

test("an unwatched network or address yields nothing", () => {
  const act = [{ fromAddress: OWNER, toAddress: POOL, hash: "0x1", value: 1, asset: "ETH", category: "external" }];
  assert.equal(alchemyChanges(delivery("BASE_MAINNET", act), watched).size, 0);
  assert.equal(alchemyChanges(delivery("ETH_MAINNET", act), new Set(["0xsomeoneelse"])).size, 0);
});

test("the signature is the body's HMAC-SHA256 with the webhook's signing key", () => {
  const body = JSON.stringify(delivery("ETH_MAINNET", []));
  const sig = createHmac("sha256", "whsec_test").update(body, "utf8").digest("hex");
  assert.equal(validAlchemySignature(body, sig, "whsec_test"), true);
  assert.equal(validAlchemySignature(body, sig, "whsec_other"), false);
  assert.equal(validAlchemySignature(body + " ", sig, "whsec_test"), false);
  assert.equal(validAlchemySignature(body, "short", "whsec_test"), false);
});
