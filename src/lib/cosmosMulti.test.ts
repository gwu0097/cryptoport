import test from "node:test";
import assert from "node:assert/strict";
import { bech32 } from "@scure/base";
import { eligibleChains, deriveAddress, holdingsFromBalances, toTokenAmount, withRegistryApis, withKeplrCurrencies, withPrices, keplrRegistryFile, stakingHoldings, lockUnlinkedSei, type DirectoryChain } from "./cosmosMulti.ts";

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
  chainId: "stride-1",
  prettyName: "Stride",
  image: null,
  stakingDenom: "ustrd",
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

test("Keplr's registry fills missing CoinGecko ids by exact denom (the stINJ / milkTIA / dATOM gap), without overriding known ones", () => {
  assert.equal(keplrRegistryFile("stride-1"), "stride.json");
  assert.equal(keplrRegistryFile("akashnet-2"), "akashnet.json");
  assert.equal(keplrRegistryFile(null), null);
  const enriched = withKeplrCurrencies(chain, {
    currencies: [
      { coinDenom: "stINJ", coinMinimalDenom: "stinj", coinDecimals: 18, coinGeckoId: "stride-staked-injective" },
      { coinDenom: "STRD", coinMinimalDenom: "ustrd", coinDecimals: 6, coinGeckoId: "something-else" }, // known id kept
      { coinDenom: "stTIA", coinMinimalDenom: "stutia", coinDecimals: 6, coinGeckoId: "stride-staked-tia", coinImageUrl: "sttia.png" }, // new
      { coinDenom: "NOID", coinMinimalDenom: "unoid", coinDecimals: 6 },
    ],
  });
  assert.equal(enriched.assets.get("stinj")!.coingeckoId, "stride-staked-injective");
  assert.equal(enriched.assets.get("ustrd")!.coingeckoId, "stride");
  assert.deepEqual(enriched.assets.get("stutia"), { denom: "stutia", symbol: "stTIA", decimals: 6, coingeckoId: "stride-staked-tia", usd: null, image: "sttia.png" });
  assert.equal(chain.assets.get("stinj")!.coingeckoId, null, "the input chain isn't mutated");

  const h = holdingsFromBalances(enriched, [
    { denom: "stinj", amount: "36777000000000000000" },
    { denom: "stutia", amount: "2000000" },
    { denom: "unoid", amount: "5000000" },
  ]);
  const priced = withPrices(h, new Map([["stride-staked-injective", 12.3], ["stride-staked-tia", null]]));
  assert.deepEqual(
    priced.map((x) => [x.ticker, x.qty, x.usd_override === null ? null : Math.round(x.usd_override * 100) / 100]),
    [
      ["stINJ", 36.777, 452.36],
      ["stTIA", 2, null], // id but no CoinGecko price: stays unpriced
      ["NOID", 5, null], // known token, no id: unpriced by name
    ],
  );
});

test("staking: staked, rewards and unbonding rows per validator, priced by the staking token's own id", () => {
  const V = "stridevaloper1abcdefghijklmnop";
  const h = stakingHoldings(
    chain,
    {
      delegations: [{ validator: V, amount: "150000000" }],
      rewards: [{ validator: V, amount: "2500000.123" }, { validator: V, amount: "0.4" }],
      unbonding: [{ validator: V, amount: "40000000", completionTime: "2026-10-15T08:00:00Z" }],
    },
    new Map([[V, "Stakecito"]]),
  );
  assert.deepEqual(
    h.map((x) => [x.protocol_section, x.qty, x.usd_override, x.display_label]),
    [
      ["Staked", 150, 3, "Staked · Stakecito"],
      ["Rewards", 2.500000123, 0.05000000246, "Staking rewards · Stakecito"],
      ["Unbonding", 40, 0.8, "Unbonding · Stakecito · available 2026-10-15"],
    ],
  );
  assert.ok(h.every((x) => x.ticker === "STRD" && x.contract === "ustrd" && x.coingecko_id === "stride" && x.category === "defi" && x.protocol === "Stride staking"));
});

test("staking on a chain whose token the registry can't identify is skipped (no amount can be trusted)", () => {
  assert.deepEqual(stakingHoldings({ ...chain, stakingDenom: "unknown" }, { delegations: [{ validator: "v", amount: "5" }], rewards: [], unbonding: [] }, new Map()), []);
});

test("an unlinked Sei account's rows stay listed but become unpriced, id-less and labeled; other chains untouched", () => {
  const base = { qty: 1, contract: "usei", category: "defi" as const, icon_url: null };
  const out = lockUnlinkedSei([
    { ...base, ticker: "SEI", usd_override: 91.2, chain: "sei", coingecko_id: "sei-network", display_label: "Staked · MantiCore", protocol_section: "Staked" as const },
    { ...base, ticker: "SEI", usd_override: 3, chain: "sei", coingecko_id: "sei-network", display_label: null, category: "token" as const },
    { ...base, ticker: "ATOM", usd_override: 5, chain: "cosmoshub", coingecko_id: "cosmos", display_label: null },
  ]);
  assert.deepEqual(
    out.map((h) => [h.chain, h.usd_override, h.coingecko_id, h.display_label]),
    [
      ["sei", null, null, "Staked · MantiCore — locked: Sei Cosmos account with no linked EVM address (SIP-3)"],
      ["sei", null, null, "SEI — locked: Sei Cosmos account with no linked EVM address (SIP-3)"],
      ["cosmoshub", 5, "cosmos", null],
    ],
  );
  assert.equal(out[0].qty, 1, "amounts are kept");
});
