import test from "node:test";
import assert from "node:assert/strict";
import { sumOrNull, resolveGroups, aggregateGroupTotals, sumDailySeriesAcrossSlugs, rollingSum, type ProtocolForGrouping, dominantCategory, sectorCategoryFor, mixedChainAppGroups } from "./aggregate.ts";

const proto = (slug: string, geckoId: string | null, parentProtocol: string | null, tvl = 1, mcap: number | null = null): ProtocolForGrouping => ({
  slug,
  geckoId,
  category: "Dexs",
  tvl,
  mcap,
  parentProtocol,
});

test("sumOrNull: null only when every input is unknown, never a fabricated 0", () => {
  assert.equal(sumOrNull([null, undefined]), null);
  assert.equal(sumOrNull([null, 5, 2]), 7);
  assert.equal(sumOrNull([0, null]), 0);
});

test("resolveGroups: children with no gecko_id resolve through their parent and group together", () => {
  const parents = new Map([["parent#uniswap", { geckoId: "uniswap", mcap: 900 }]]);
  const { groups, unresolved } = resolveGroups(
    [proto("uniswap-v2", null, "parent#uniswap", 10), proto("uniswap-v3", null, "parent#uniswap", 20), proto("orphan", null, null)],
    parents,
  );
  assert.deepEqual(groups.get("uniswap")?.contributingSlugs, ["uniswap-v2", "uniswap-v3"]);
  assert.equal(groups.get("uniswap")?.tvl, 30);
  assert.equal(groups.get("uniswap")?.mcapForConflictCheck, 900, "parent mcap, never summed across children");
  assert.deepEqual(unresolved.map((p) => p.slug), ["orphan"]);
});

test("resolveGroups: a protocol's own gecko_id wins over its parent's", () => {
  const parents = new Map([["parent#aave", { geckoId: "aave-parent-id", mcap: 1 }]]);
  const { groups } = resolveGroups([proto("aave-v2", "aave", "parent#aave")], parents);
  assert.ok(groups.has("aave"));
  assert.ok(!groups.has("aave-parent-id"));
});

test("aggregateGroupTotals sums every contributing slug (the live path)", () => {
  const t = (total30d: number | null) => ({ total24h: null, total7d: null, total30d, total1y: null });
  const fees = new Map([
    ["hl-spot", t(1)],
    ["hl-perps", t(100)],
  ]);
  const totals = aggregateGroupTotals(["hl-spot", "hl-perps"], fees, new Map(), new Map());
  assert.equal(totals.fees30d, 101);
  assert.equal(totals.revenue30d, null, "no slug reports revenue -> unknown, not 0");
});

test("sumDailySeriesAcrossSlugs sums per date, keeps partial dates, drops all-unknown dates", () => {
  const series = new Map([
    ["a", [{ date: "2026-01-01", value: 1 }, { date: "2026-01-02", value: 2 }]],
    ["b", [{ date: "2026-01-02", value: 10 }, { date: "2026-01-03", value: 20 }]],
  ]);
  assert.deepEqual(sumDailySeriesAcrossSlugs(["a", "b", "missing"], series), [
    { date: "2026-01-01", value: 1 },
    { date: "2026-01-02", value: 12 },
    { date: "2026-01-03", value: 20 },
  ]);
});

test("the live and backfill paths agree: summed daily history == sum of each slug's own history", () => {
  // Regression for the single-slug backfill bug (Hyperliquid revenue null,
  // Uniswap fees 3.5x low): a group's backfilled series must include every slug.
  const series = new Map([
    ["hyperliquid-spot-orderbook", [{ date: "2026-01-01", value: 1 }]],
    ["hyperliquid-perps", [{ date: "2026-01-01", value: 99 }]],
  ]);
  const [point] = sumDailySeriesAcrossSlugs(["hyperliquid-spot-orderbook", "hyperliquid-perps"], series);
  assert.equal(point.value, 100);
});

test("rollingSum is a trailing window by calendar date, not by point count", () => {
  const r = rollingSum(
    [
      { date: "2026-01-01", value: 1 },
      { date: "2026-01-02", value: 2 },
      { date: "2026-01-05", value: 4 },
    ],
    3,
  );
  assert.equal(r.get("2026-01-02"), 3);
  assert.equal(r.get("2026-01-05"), 4, "01-01 and 01-02 fall outside a 3-day window ending 01-05");
});

test("dominantCategory: the highest-revenue child sets the sector, not the first child", () => {
  const cats = new Map([
    ["hyperliquid-spot-orderbook", "Dexs"],
    ["hyperliquid-perps", "Derivatives"],
  ]);
  const rev = new Map([
    ["hyperliquid-spot-orderbook", 1],
    ["hyperliquid-perps", 99],
  ]);
  assert.equal(
    dominantCategory(["hyperliquid-spot-orderbook", "hyperliquid-perps"], cats, (s) => rev.get(s), () => null),
    "Derivatives",
  );
});

test("dominantCategory: falls back to fees, then to any child with a category", () => {
  const cats = new Map<string, string | null>([["a", "Dexs"], ["b", "Launchpad"], ["c", null]]);
  assert.equal(dominantCategory(["a", "b"], cats, () => null, (s) => (s === "b" ? 10 : 1)), "Launchpad");
  assert.equal(dominantCategory(["c", "a"], cats, () => null, () => null), "Dexs");
  assert.equal(dominantCategory(["c"], cats, () => null, () => null), null);
});

test("sector follows the fee data: a chain's own fee entry is 'Chain', whatever /protocols calls the slug (audit 2026-09-24)", () => {
  // bitcoin: /protocols says Canonical Bridge (the bridge TVL listing), fees are chain#bitcoin
  assert.equal(sectorCategoryFor("Canonical Bridge", { defillamaId: "chain#bitcoin" }), "Chain");
  // sui-foundation's fee entry really is a bridge protocol (id 3181): unchanged
  assert.equal(sectorCategoryFor("Canonical Bridge", { defillamaId: "3181" }), "Canonical Bridge");
  assert.equal(sectorCategoryFor("Dexs", { defillamaId: "6933" }), "Dexs");
  assert.equal(sectorCategoryFor("Lending", undefined), "Lending");
  assert.equal(sectorCategoryFor(null, { defillamaId: null }), null);
});

test("mixedChainAppGroups flags a chain token that also absorbed a parent-filed app (FLOW + FlowSwap), not ordinary groups", () => {
  const protocols = new Map<string, ProtocolForGrouping>(
    [
      { slug: "flowswap-v3", geckoId: null, category: "Dexs", tvl: null, mcap: null, parentProtocol: "parent#flow-swap" },
      { slug: "flow", geckoId: "flow", category: "Chain", tvl: null, mcap: null, parentProtocol: null },
      { slug: "uniswap-v3", geckoId: null, category: "Dexs", tvl: null, mcap: null, parentProtocol: "parent#uniswap" },
      { slug: "uniswap-v2", geckoId: null, category: "Dexs", tvl: null, mcap: null, parentProtocol: "parent#uniswap" },
      { slug: "bitcoin", geckoId: "bitcoin", category: "Canonical Bridge", tvl: null, mcap: null, parentProtocol: null },
    ].map((p) => [p.slug, p]),
  );
  const parents = new Map([
    ["parent#flow-swap", { geckoId: "flow", mcap: null }],
    ["parent#uniswap", { geckoId: "uniswap", mcap: null }],
  ]);
  const { groups } = resolveGroups([...protocols.values()], parents);
  assert.deepEqual(mixedChainAppGroups(groups, protocols), [{ geckoId: "flow", chainSlugs: ["flow"], appSlugs: ["flowswap-v3"] }]);
  // With the app excluded (config slugExclusions), nothing is flagged.
  const { groups: g2 } = resolveGroups([...protocols.values()].filter((p) => p.slug !== "flowswap-v3"), parents);
  assert.deepEqual(mixedChainAppGroups(g2, protocols), []);
});
