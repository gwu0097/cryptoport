import test from "node:test";
import assert from "node:assert/strict";
import { rankPeers, MIN_CORRELATION, MIN_OVERLAP_HOURS, type CorrelatedCandidate } from "./trendFinder.ts";

function peer(overrides: Partial<CorrelatedCandidate> & { id: string }): CorrelatedCandidate {
  return {
    symbol: overrides.id.toUpperCase(),
    imageUrl: null,
    price: 1,
    change1h: null,
    change24h: null,
    change7d: null,
    marketCap: 1_000_000_000,
    correlation: 0.3,
    overlapHours: 2000,
    ...overrides,
  };
}

test("rankPeers excludes the seed itself", () => {
  const candidates = [peer({ id: "seed" }), peer({ id: "sui" })];
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["sui"]);
});

test("rankPeers excludes a candidate below MIN_CORRELATION — not a weak peer, not a peer", () => {
  const candidates = [
    peer({ id: "real-peer", correlation: MIN_CORRELATION }),
    peer({ id: "junk", correlation: MIN_CORRELATION - 0.01 }),
  ];
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["real-peer"]);
});

test("rankPeers excludes a candidate with too little overlap, even with a high correlation", () => {
  const candidates = [
    peer({ id: "enough-history", overlapHours: MIN_OVERLAP_HOURS }),
    peer({ id: "too-new", overlapHours: MIN_OVERLAP_HOURS - 1, correlation: 0.9 }),
  ];
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["enough-history"]);
});

test("rankPeers applies the market-cap floor, excluding unknown market cap", () => {
  const candidates = [
    peer({ id: "a", marketCap: 300_000_000 }),
    peer({ id: "b", marketCap: 100_000_000 }),
    peer({ id: "c", marketCap: null }),
  ];
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 200_000_000 });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
});

test("rankPeers sorts descending by correlation strength — strongest peer first", () => {
  const candidates = [
    peer({ id: "weak", correlation: 0.18 }),
    peer({ id: "strongest", correlation: 0.4 }),
    peer({ id: "mid", correlation: 0.25 }),
  ];
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result.map((r) => r.id), ["strongest", "mid", "weak"]);
});

test("rankPeers caps the result at 20 peers even if more clear every threshold", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => peer({ id: `peer-${i}`, correlation: 0.2 + i * 0.001 }));
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 0 });
  assert.equal(result.length, 20);
  // Highest-correlation 20 survive the cap, not an arbitrary slice.
  assert.equal(result[0].id, "peer-29");
  assert.equal(result[19].id, "peer-10");
});

test("rankPeers returns an empty list, not a padded one, when nothing clears the bar", () => {
  const candidates = [peer({ id: "weak1", correlation: 0.05 }), peer({ id: "weak2", correlation: 0.02 })];
  const result = rankPeers(candidates, { seedId: "seed", mcapFloor: 0 });
  assert.deepEqual(result, []);
});
