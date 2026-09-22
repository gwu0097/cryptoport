import test from "node:test";
import assert from "node:assert/strict";
import { rankPeers, type PeerRow } from "./trendFinder.ts";

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
