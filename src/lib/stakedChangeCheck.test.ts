import { test } from "node:test";
import assert from "node:assert/strict";
import { implausibleStakedChanges, type ChangeRow } from "./stakedChangeCheck.ts";

const tokens = [
  { coingeckoId: "socean-staked-sol", symbol: "inf", baseSymbol: "SOL" },
  { coingeckoId: "jito-staked-sol", symbol: "jitosol", baseSymbol: "SOL" },
  { coingeckoId: "jupiter-staked-sol", symbol: "jupsol", baseSymbol: "SOL" },
  { coingeckoId: "generic-lst", symbol: "glst", baseSymbol: null },
];
const row = (key: string, symbol: string, change: number | null, marketCap: number | null = 1e6): ChangeRow => ({ key, symbol, change, marketCap });

test("INF's +11.29% against SOL's −6.77% is unknown; staked tokens near SOL keep theirs (2026-10-08's real figures)", () => {
  const rows = [row("solana", "SOL", -6.77, 64e9), row("socean-staked-sol", "INF", 11.29), row("jito-staked-sol", "JITOSOL", -6.63), row("jupiter-staked-sol", "JUPSOL", -6.64)];
  assert.deepEqual([...implausibleStakedChanges(rows, tokens)], ["socean-staked-sol"]);
});

test("the base is the biggest coin with that symbol, not a namesake", () => {
  const rows = [row("solana", "SOL", -6.77, 64e9), row("sol-namesake", "SOL", 12, 1e5), row("socean-staked-sol", "INF", 11.29)];
  assert.deepEqual([...implausibleStakedChanges(rows, tokens)], ["socean-staked-sol"]);
});

test("without the base coin among the prices, the staked tokens' median is the reference — at least three of them", () => {
  const withPeers = [row("socean-staked-sol", "INF", 11.29), row("jito-staked-sol", "JITOSOL", -6.63), row("jupiter-staked-sol", "JUPSOL", -6.64)];
  assert.deepEqual([...implausibleStakedChanges(withPeers, tokens)], ["socean-staked-sol"]);
  const onePeer = [row("socean-staked-sol", "INF", 11.29), row("jito-staked-sol", "JITOSOL", -6.63)];
  assert.equal(implausibleStakedChanges(onePeer, tokens).size, 0);
});

test("a token with no known base, or a missing change, is left alone", () => {
  const rows = [row("solana", "SOL", -6.77, 64e9), row("generic-lst", "GLST", 30), row("socean-staked-sol", "INF", null)];
  assert.equal(implausibleStakedChanges(rows, tokens).size, 0);
});
