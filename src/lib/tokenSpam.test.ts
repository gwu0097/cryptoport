import test from "node:test";
import assert from "node:assert/strict";
import { spamSign } from "./tokenSpam.ts";

const LISTED = new Set(["USDC", "USDT", "SHIB", "WETH"]);

test("a symbol advertising a site, a handle or a claim is spam — any domain ending", () => {
  for (const s of ["$ Visit usdc-gift.com", "https://x.io", "t.me/free", "Claim your AIRDROP", "ETHG.lat", "Zepe.io", "better-gmx.eth.link", "RareTrx.xyz", "密马.com", "ecAVAX - investpulse.ink", "电报号 @biZhangHao", "DogX.AI PreSale"]) {
    assert.equal(spamSign(s, LISTED), "advertises", s);
  }
});

test("an unlisted token named like a listed coin on its chain is an impostor", () => {
  assert.equal(spamSign("USDC", LISTED), "impersonates");
  assert.equal(spamSign("shib", LISTED), "impersonates");
});

test("look-alike letters from another alphabet are spam", () => {
  assert.equal(spamSign("U\u0405D\u0422", LISTED), "lookalike"); // UЅDТ
});

test("real unlisted tokens aren't spam, bridge suffixes included", () => {
  for (const s of ["hUSDB", "aTkoWETH", "YFIB", "USDC.e", "BTC.b", "USDC.axl", "WETH.e", "COM", "Cake-LP", "RAFFLE TICKET", null]) assert.equal(spamSign(s, LISTED), null, String(s));
});
