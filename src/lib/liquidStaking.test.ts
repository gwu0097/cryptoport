import test from "node:test";
import assert from "node:assert/strict";
import { categoryBase, inferBase, resolveBases, consolidateLiquidStaking, type LiquidStakingToken } from "./liquidStaking.ts";
import type { AssetGroup, AssetHoldingEntry } from "./queries.ts";

const holding = (ticker: string, usd: number | null): AssetHoldingEntry =>
  ({ ticker, valuation: usd === null ? { kind: "unpriced", reason: "x" } : { kind: "priced", usd } }) as unknown as AssetHoldingEntry;

const group = (ticker: string, o: Partial<AssetGroup> & { usd?: (number | null)[] } = {}): AssetGroup => {
  const holdings = (o.usd ?? []).map((u) => holding(ticker, u));
  return {
    tickerKey: ticker.toUpperCase(), ticker, iconUrl: null, totalQty: 1,
    total: holdings.reduce((s, h) => s + (h.valuation.kind === "priced" ? h.valuation.usd : 0), 0),
    unpricedCount: holdings.filter((h) => h.valuation.kind === "unpriced").length, price: null, change24h: null, change1h: null,
    change7d: null, change30d: null, marketCap: null, coingeckoId: null, holdings, ...o,
  };
};

const lst = (coingeckoId: string, symbol: string, baseSymbol: string | null = null): LiquidStakingToken => ({ coingeckoId, symbol, baseSymbol });

test("categoryBase reads the base coin from CoinGecko's coin-specific category names only", () => {
  assert.equal(categoryBase("Liquid Staked ETH"), "ETH");
  assert.equal(categoryBase("Liquid Restaked SOL"), "SOL");
  assert.equal(categoryBase("Liquid Staked HYPE\t"), "HYPE");
  assert.equal(categoryBase("Liquid Staking Tokens"), null);
  assert.equal(categoryBase("Liquid Restaking Governance Tokens"), null);
});

test("inferBase: short prefix or 1-2 char suffix around a held coin, longest wins, 3+ chars", () => {
  const held = ["ETH", "ATOM", "TIA", "AVAX", "USDE", "S", "MATIC"];
  assert.equal(inferBase("statom", held), "ATOM");
  assert.equal(inferBase("datom", held), "ATOM");
  assert.equal(inferBase("milktia", held), "TIA");
  assert.equal(inferBase("savax", held), "AVAX");
  assert.equal(inferBase("maticx", held), "MATIC");
  assert.equal(inferBase("eth2", held), "ETH");
  assert.equal(inferBase("wbeth", held), "ETH");
  assert.equal(inferBase("susde", held), "USDE");
  assert.equal(inferBase("sts", held), null, "one-letter S never matches");
  assert.equal(inferBase("strx", held), null);
  assert.equal(inferBase("ethereumx", held), null, "suffix too long");
});

const TOKENS = [
  lst("wrapped-eeth", "weeth"), // only in the generic restaking category
  lst("staked-ether", "steth", "ETH"),
  lst("wrapped-steth", "wsteth", "ETH"),
  lst("stader-maticx", "maticx"),
  lst("lido-staked-matic", "stmatic"),
  lst("stride-staked-atom", "statom"),
  lst("drop-staked-atom", "datom"),
  lst("stride-staked-injective", "stinj"),
];

test("resolveBases: category base first, else inferred from held coins; MATIC tokens land on POL", () => {
  const groups = [
    group("ETH"), group("POL"), group("ATOM"), group("INJ"), group("BTC"),
    group("weETH", { coingeckoId: "wrapped-eeth" }),
    group("stETH"), // no id: matched by symbol
    group("wstETH", { coingeckoId: "wrapped-steth" }),
    group("MaticX"), group("stMATIC"), group("stATOM"), group("dATOM"), group("stINJ"),
  ];
  const bases = resolveBases(groups, TOKENS);
  assert.deepEqual(Object.fromEntries(bases), {
    WEETH: "ETH", STETH: "ETH", WSTETH: "ETH", MATICX: "POL", STMATIC: "POL", STATOM: "ATOM", DATOM: "ATOM", STINJ: "INJ",
  });
});

test("resolveBases: a generic token whose base isn't held and has no category stays as it is", () => {
  const bases = resolveBases([group("stINJ")], TOKENS);
  assert.equal(bases.size, 0);
});

test("resolveBases: a symbol two tokens share with different bases is left alone unless the id decides", () => {
  const tokens = [lst("a", "ssui", "SUI"), lst("b", "ssui", "SOL")];
  assert.equal(resolveBases([group("SUI"), group("SOL"), group("sSUI")], tokens).size, 0);
  assert.equal(resolveBases([group("SUI"), group("sSUI", { coingeckoId: "a" })], tokens).get("SSUI"), "SUI");
});

test("consolidate: staked tokens fold into their base; totals unchanged; each holding keeps its value", () => {
  const eth = group("ETH", { totalQty: 2, price: 4000, usd: [8000] });
  const weeth = group("weETH", { totalQty: 1, price: 4300, usd: [4300] });
  const steth = group("stETH", { totalQty: 1, price: 4000, usd: [4000] });
  const btc = group("BTC", { usd: [100000] });
  const out = consolidateLiquidStaking([btc, eth, weeth, steth], new Map([["WEETH", "ETH"], ["STETH", "ETH"]]));
  assert.deepEqual(out.map((g) => g.tickerKey), ["BTC", "ETH"]);
  const e = out[1];
  assert.equal(e.total, 16300);
  assert.equal(e.totalQty, 2 + 4300 / 4000 + 1);
  assert.deepEqual(e.combinedTickers, ["weETH", "stETH"]);
  assert.deepEqual(e.holdings.map((h) => h.ticker), ["ETH", "weETH", "stETH"]);
  assert.equal(out.reduce((s, g) => s + g.total, 0), [eth, weeth, steth, btc].reduce((s, g) => s + g.total, 0));
});

test("consolidate: an unpriced staked holding makes the base quantity unknown, not a partial sum", () => {
  const out = consolidateLiquidStaking([group("SOL", { totalQty: 5, price: 200, usd: [1000] }), group("mSOL", { usd: [null] })], new Map([["MSOL", "SOL"]]));
  assert.equal(out[0].totalQty, null);
  assert.equal(out[0].unpricedCount, 1);
});

test("consolidate: staked tokens without their base coin still get a base row; nothing to combine = same array", () => {
  const out = consolidateLiquidStaking([group("stMATIC", { usd: [2120] }), group("MaticX", { usd: [2631] })], new Map([["STMATIC", "POL"], ["MATICX", "POL"]]));
  assert.deepEqual([out.length, out[0].tickerKey, out[0].total, out[0].totalQty], [1, "POL", 4751, null]);
  const groups = [group("ETH", { usd: [1] })];
  assert.equal(consolidateLiquidStaking(groups, new Map()), groups);
});

test("rows keyed by coin id (pricing phase 2): symbols still match on the display ticker, bases come back as row keys", () => {
  const groups = [
    group("ETH", { tickerKey: "ethereum" }),
    group("ATOM", { tickerKey: "cosmos" }),
    group("stETH", { tickerKey: "staked-ether", coingeckoId: "staked-ether" }),
    group("stATOM", { tickerKey: "stride-staked-atom", coingeckoId: "stride-staked-atom" }),
  ];
  const bases = resolveBases(groups, [lst("staked-ether", "steth", "ETH"), lst("stride-staked-atom", "statom")]);
  assert.deepEqual(Object.fromEntries(bases), { "staked-ether": "ethereum", "stride-staked-atom": "cosmos" });
  const out = consolidateLiquidStaking(groups, bases);
  assert.deepEqual(out.map((g) => g.tickerKey).sort(), ["cosmos", "ethereum"]);
});
