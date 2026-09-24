import test from "node:test";
import assert from "node:assert/strict";
import { bech32 } from "@scure/base";
import { eligibleChains, deriveAddress, holdingsFromBalances, toTokenAmount, withRegistryApis, type DirectoryChain } from "./cosmosMulti.ts";

const bytes = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
const COSMOS = bech32.encode("cosmos", bech32.toWords(bytes));

test("the same account is derived on other coin-type-118 chains; non-cosmos1 input throws", () => {
  const osmo = deriveAddress(COSMOS, "osmo");
  assert.ok(osmo.startsWith("osmo1"));
  assert.deepEqual(Uint8Array.from(bech32.fromWords(bech32.decode(osmo as `${string}1${string}`).words)), bytes);
  assert.throws(() => deriveAddress(bech32.encode("osmo", bech32.toWords(bytes)), "stride"), /Not a cosmos1/);
});

test("only live mainnet coin-type-118 chains are scanned (Injective, coin type 60, never is)", () => {
  const chains = eligibleChains([
    { name: "osmosis", pretty_name: "Osmosis", bech32_prefix: "osmo", slip44: 118, status: "live", network_type: "mainnet", best_apis: { rest: [{ address: "https://a.example/" }] } },
    { name: "injective", bech32_prefix: "inj", slip44: 60, status: "live", network_type: "mainnet" },
    { name: "soon", bech32_prefix: "soon", slip44: 118, status: "upcoming", network_type: "mainnet" },
    { name: "testy", bech32_prefix: "test", slip44: 118, status: "live", network_type: "testnet" },
  ]);
  assert.deepEqual(chains.map((c) => c.name), ["osmosis"]);
  assert.deepEqual(chains[0].restUrls, ["https://rest.cosmos.directory/osmosis", "https://a.example"]);
  assert.equal(chains[0].needsRegistryApis, false);
});

test("a chain with no listed endpoint gets its chain-registry REST endpoints, after the proxy", () => {
  const [neutron] = eligibleChains([{ name: "neutron", bech32_prefix: "neutron", slip44: 118, status: "live", network_type: "mainnet", best_apis: { rest: [] } }]);
  assert.equal(neutron.needsRegistryApis, true);
  const enriched = withRegistryApis(neutron, { apis: { rest: [{ address: "https://rest-lb.neutron.org/" }, { address: "https://b.example" }, { address: "https://c.example" }, { address: "https://d.example" }] } });
  assert.deepEqual(enriched.restUrls, ["https://rest.cosmos.directory/neutron", "https://rest-lb.neutron.org", "https://b.example", "https://c.example"]);
  assert.equal(withRegistryApis(neutron, null).restUrls.length, 1, "no chain.json: just the proxy");
});

test("toTokenAmount is exact for 18-decimal amounts past Number.MAX_SAFE_INTEGER", () => {
  assert.equal(toTokenAmount("30791347920017973000", 18), 30.791347920017973);
  assert.equal(toTokenAmount("1500000", 6), 1.5);
});

const chain: DirectoryChain = {
  name: "stride",
  prettyName: "Stride",
  prefix: "stride",
  restUrls: [],
  needsRegistryApis: false,
  assets: new Map([
    ["ustrd", { denom: "ustrd", symbol: "STRD", decimals: 6, coingeckoId: "stride", usd: 0.02, image: "strd.png" }],
    ["stinj", { denom: "stinj", symbol: "stINJ", decimals: 18, coingeckoId: null, usd: null, image: "stinj.png" }],
    ["ibc/BF3B", { denom: "ibc/BF3B", symbol: "TIA", decimals: 6, coingeckoId: "celestia", usd: null, image: null }],
  ]),
};

test("known tokens are priced only by their own CoinGecko id; no id or no price = unpriced (never a ticker lookup)", () => {
  const h = holdingsFromBalances(chain, [
    { denom: "ustrd", amount: "2000000" },
    { denom: "stinj", amount: "500000000000000000" },
    { denom: "ibc/BF3B", amount: "1000000" },
    { denom: "ustrd", amount: "0" },
  ]);
  assert.equal(h.length, 3, "zero balances skipped");
  assert.deepEqual(
    h.map((x) => [x.ticker, x.qty, x.usd_override, x.coingecko_id]),
    [
      ["STRD", 2, 0.04, "stride"],
      ["stINJ", 0.5, null, null], // no CoinGecko id: listed, unpriced
      ["TIA", 1, null, "celestia"], // id but no price in this snapshot: unpriced until Refresh prices
    ],
  );
  assert.ok(h.every((x) => x.chain === "stride" && x.contract));
});

test("an unrecognized denom is listed (not hidden) with qty unknown, never a raw base-unit number", () => {
  const [h] = holdingsFromBalances(chain, [{ denom: "ibc/4B322204B4F59D0000000000000000000000000000000000000000000000ABCD", amount: "123456789" }]);
  assert.equal(h.qty, null);
  assert.equal(h.usd_override, null);
  assert.equal(h.coingecko_id, null);
  assert.match(h.display_label!, /Unrecognized token on Stride/);
  assert.equal(h.contract.length, 68, "the full denom is kept as its identity");
});
