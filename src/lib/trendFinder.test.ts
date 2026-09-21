import test from "node:test";
import assert from "node:assert/strict";
import { rankPeers, matchCategoryName, type PeerRow, type CategoryNameStat } from "./trendFinder.ts";

function peer(overrides: Partial<PeerRow> & { id: string }): PeerRow {
  return {
    symbol: overrides.id.toUpperCase(),
    name: overrides.id,
    imageUrl: null,
    price: 1,
    change1h: null,
    change24h: null,
    change7d: null,
    marketCap: 1_000_000_000,
    ...overrides,
  };
}

test("rankPeers excludes the seed itself", () => {
  const members = [peer({ id: "seed" }), peer({ id: "ondo" })];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["ondo"]);
});

test("rankPeers applies the market-cap floor, excluding unknown market cap", () => {
  const members = [
    peer({ id: "a", marketCap: 300_000_000 }),
    peer({ id: "b", marketCap: 100_000_000 }),
    peer({ id: "c", marketCap: null }),
  ];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 200_000_000 });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
});

test("rankPeers sorts ascending by 24h change — laggards first, already-moved still included", () => {
  const members = [
    peer({ id: "moved", change24h: 45 }),
    peer({ id: "laggard", change24h: 1 }),
    peer({ id: "mid", change24h: 10 }),
  ];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["laggard", "mid", "moved"]);
});

test("rankPeers sorts members with unknown 24h change last, not as if flat", () => {
  const members = [
    peer({ id: "unknown", change24h: null }),
    peer({ id: "down", change24h: -5 }),
    peer({ id: "up", change24h: 5 }),
  ];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["down", "up", "unknown"]);
});

function cat(id: string, name: string): CategoryNameStat {
  return { id, name };
}

test("matchCategoryName picks the exact-name match over a same-family partial match — the 'Tokenized Uranium' trap", () => {
  const categories = [
    cat("tokenized-uranium", "Tokenized Uranium"),
    cat("tokenized-gold", "Tokenized Gold"),
    cat("tokenized-assets", "Tokenized Assets"),
    cat("real-world-assets", "Real World Assets (RWA)"),
  ];
  const result = matchCategoryName("Tokenized Assets", categories);
  assert.equal(result?.id, "tokenized-assets");
});

test("matchCategoryName matches a guess against the real name even with a parenthetical abbreviation", () => {
  const categories = [cat("real-world-assets", "Real World Assets (RWA)"), cat("privacy-coins", "Privacy Coins")];
  const result = matchCategoryName("Real World Assets", categories);
  assert.equal(result?.id, "real-world-assets");
});

test("matchCategoryName returns null when nothing scores above the confidence bar", () => {
  const categories = [cat("meme-coins", "Meme Coins"), cat("gaming", "Gaming (GameFi)")];
  const result = matchCategoryName("Institutional RWA Credit Infrastructure", categories);
  assert.equal(result, null);
});

test("matchCategoryName returns null for an empty or purely-stopword guess", () => {
  assert.equal(matchCategoryName("", [cat("a", "Something")]), null);
  assert.equal(matchCategoryName("the and for", [cat("a", "Something")]), null);
});
