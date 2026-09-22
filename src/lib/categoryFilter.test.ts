import test from "node:test";
import assert from "node:assert/strict";
import { splitFunctionalCategories, anchorCategories } from "./categoryFilter.ts";

// Real CoinGecko /coins/{id} category lists, captured live 2026-09-22.
const LAYERZERO = ["Smart Contract Platform", "BNB Chain Ecosystem", "Avalanche Ecosystem", "Polygon Ecosystem", "Arbitrum Ecosystem", "Ethereum Ecosystem", "Optimism Ecosystem", "Base Ecosystem", "Multicoin Capital Portfolio", "Cross-chain Communication", "Circle Ventures Portfolio", "Sequoia Capital Portfolio", "OKX Ventures Portfolio", "Base Native"];
const WORMHOLE = ["Solana Ecosystem", "Arbitrum Ecosystem", "Ethereum Ecosystem", "Interoperability", "Base Ecosystem", "Multicoin Capital Portfolio", "Cross-chain Communication", "Made in USA", "Governance", "Base Native"];
const AERODROME = ["Decentralized Exchange (DEX)", "Exchange-based Tokens", "Decentralized Finance (DeFi)", "Automated Market Maker (AMM)", "Base Ecosystem", "Binance Alpha Spotlight", "Made in USA", "Base Native"];
const NEAR = ["Artificial Intelligence (AI)", "Smart Contract Platform", "Layer 1 (L1)", "Near Protocol Ecosystem", "Alleged SEC Securities", "FTX Holdings", "Data Availability", "Coinbase Ventures Portfolio", "Proof of Stake (PoS)", "GMCI Layer 1 Index", "GMCI 30 Index", "Made in USA", "Coinbase 50 Index", "Chain Abstraction", "CoinList Launchpad", "Privacy Infrastructure", "Privacy"];
const ZCASH = ["Smart Contract Platform", "Privacy Coins", "Layer 1 (L1)", "Zero Knowledge (ZK)", "Proof of Work (PoW)", "Pantera Capital Portfolio", "Made in USA", "Coinbase 50 Index", "Quantum-Resistant", "Privacy"];

const overlap = (a: string[], b: string[]) => anchorCategories(a).filter((c) => anchorCategories(b).includes(c));

test("LayerZero anchors on what it does, not chains/investors it's associated with", () => {
  assert.deepEqual(anchorCategories(LAYERZERO), ["Cross-chain Communication"]);
});

test("Wormhole is a peer of LayerZero; Aerodrome is not (the reported ZRO case)", () => {
  assert.deepEqual(overlap(LAYERZERO, WORMHOLE), ["Cross-chain Communication"]);
  assert.deepEqual(overlap(LAYERZERO, AERODROME), [], "sharing Base Ecosystem / Base Native is chain membership, not function");
});

test("a real cross-token narrative with a shared function still matches (NEAR privacy + ZEC)", () => {
  assert.ok(overlap(NEAR, ZCASH).includes("Privacy"));
});

test("umbrella categories are only the fallback, never alongside specific ones", () => {
  assert.ok(!anchorCategories(AERODROME).includes("Decentralized Finance (DeFi)"));
  assert.deepEqual(anchorCategories(["Decentralized Finance (DeFi)", "Ethereum Ecosystem"]), ["Decentralized Finance (DeFi)"]);
});

test("a token with only non-functional categories has no anchor", () => {
  assert.deepEqual(anchorCategories(["Base Ecosystem", "Made in USA", "Governance"]), []);
});

test("drops every non-functional pattern seen live", () => {
  const { dropped } = splitFunctionalCategories(NEAR);
  for (const c of ["Near Protocol Ecosystem", "Alleged SEC Securities", "FTX Holdings", "Coinbase Ventures Portfolio", "Proof of Stake (PoS)", "GMCI Layer 1 Index", "GMCI 30 Index", "Made in USA", "Coinbase 50 Index", "CoinList Launchpad"]) {
    assert.ok(dropped.includes(c), c);
  }
});
