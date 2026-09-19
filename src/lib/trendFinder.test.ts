import test from "node:test";
import assert from "node:assert/strict";
import { rankCategories, rankPeers, type CategoryCap, type CategoryMember } from "./trendFinder.ts";

function caps(entries: [string, Partial<CategoryCap>][]): Map<string, CategoryCap> {
  const map = new Map<string, CategoryCap>();
  for (const [name, partial] of entries) {
    map.set(name, { id: name.toLowerCase().replace(/\s+/g, "-"), name, marketCap: null, marketCapChange24h: null, ...partial });
  }
  return map;
}

test("rankCategories excludes categories with null market cap (unknown, never narrowest)", () => {
  const result = rankCategories(
    ["Rollup", "Arbitrum Ecosystem"],
    caps([
      ["Rollup", { marketCap: 2_480_000_000 }],
      ["Arbitrum Ecosystem", { marketCap: null }],
    ]),
  );
  assert.deepEqual(result.map((r) => r.name), ["Rollup"]);
});

test("rankCategories excludes categories with zero market cap", () => {
  const result = rankCategories(["Some Ecosystem"], caps([["Some Ecosystem", { marketCap: 0 }]]));
  assert.deepEqual(result, []);
});

test("rankCategories drops denylisted categories even with a known, small cap", () => {
  const result = rankCategories(
    ["Rollup", "Ethereum Ecosystem", "GMCI 30 Index", "Made in USA"],
    caps([
      ["Rollup", { marketCap: 2_480_000_000 }],
      ["Ethereum Ecosystem", { marketCap: 500_000_000 }],
      ["GMCI 30 Index", { marketCap: 100_000_000 }],
      ["Made in USA", { marketCap: 50_000_000 }],
    ]),
  );
  assert.deepEqual(result.map((r) => r.name), ["Rollup"]);
});

test("rankCategories sorts ascending by market cap — narrowest sector first", () => {
  const result = rankCategories(
    ["Smart Contract Platform", "Rollup", "Layer 2 (L2)"],
    caps([
      ["Smart Contract Platform", { marketCap: 2_417_000_000_000 }],
      ["Rollup", { marketCap: 2_480_000_000 }],
      ["Layer 2 (L2)", { marketCap: 10_460_000_000 }],
    ]),
  );
  assert.deepEqual(result.map((r) => r.name), ["Rollup", "Layer 2 (L2)", "Smart Contract Platform"]);
});

test("rankCategories drops a category not present in the caps map at all", () => {
  const result = rankCategories(["Unknown Category"], new Map());
  assert.deepEqual(result, []);
});

function member(overrides: Partial<CategoryMember> & { id: string }): CategoryMember {
  return { symbol: overrides.id.toUpperCase(), imageUrl: null, price: 1, change1h: null, change24h: null, change7d: null, marketCap: 1_000_000_000, ...overrides };
}

test("rankPeers excludes the seed itself", () => {
  const members = [member({ id: "arbitrum", change24h: 5 }), member({ id: "optimism", change24h: 2 })];
  const result = rankPeers(members, { seedId: "arbitrum", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["optimism"]);
});

test("rankPeers applies the market-cap floor, excluding unknown market cap", () => {
  const members = [
    member({ id: "a", marketCap: 300_000_000 }),
    member({ id: "b", marketCap: 100_000_000 }),
    member({ id: "c", marketCap: null }),
  ];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 200_000_000 });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
});

test("rankPeers sorts ascending by 24h change — laggards first, already-moved still included", () => {
  const members = [
    member({ id: "moved", change24h: 45 }),
    member({ id: "laggard", change24h: 1 }),
    member({ id: "mid", change24h: 10 }),
  ];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["laggard", "mid", "moved"]);
});

test("rankPeers sorts members with unknown 24h change last, not as if flat", () => {
  const members = [
    member({ id: "unknown", change24h: null }),
    member({ id: "down", change24h: -5 }),
    member({ id: "up", change24h: 5 }),
  ];
  const result = rankPeers(members, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["down", "up", "unknown"]);
});
