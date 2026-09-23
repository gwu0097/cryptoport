import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveRunProvenance,
  buildBackfillRunProvenance,
  BACKFILL_PRICE_FALLBACK_OVERRIDE,
  resolveFieldProvenance,
} from "./provenance.ts";

const ctx = { geckoId: "uniswap", contributingSlugs: ["uniswap-v2", "uniswap-v3"] };

test("live manifest covers every column the live job writes", () => {
  const fields = Object.keys(buildLiveRunProvenance("t").fields).sort();
  assert.deepEqual(fields, [
    "circulating_supply", "fdv_usd", "fees_1y", "fees_24h", "fees_30d", "fees_7d",
    "holders_revenue_24h", "holders_revenue_30d", "market_cap_usd", "max_supply", "price_usd",
    "revenue_1y", "revenue_24h", "revenue_30d", "revenue_7d", "total_supply", "tvl_usd", "volume_24h_usd",
  ]);
});

test("resolves from the run manifest when the row has no override", () => {
  const p = resolveFieldProvenance("price_usd", buildLiveRunProvenance("2026-09-23T07:00:00Z"), null, ctx);
  assert.deepEqual(p, { source: "coingecko", endpoints: ["/coins/markets"], fetched_at: "2026-09-23T07:00:00Z" });
});

test("expands {slug} once per contributing slug and {gecko_id} to the asset", () => {
  const run = buildBackfillRunProvenance("t");
  assert.deepEqual(resolveFieldProvenance("fees_30d", run, null, ctx)?.endpoints, [
    "/summary/fees/uniswap-v2?dataType=dailyFees",
    "/summary/fees/uniswap-v3?dataType=dailyFees",
  ]);
  assert.deepEqual(resolveFieldProvenance("price_usd", run, null, ctx)?.endpoints, ["/chart/coingecko:uniswap"]);
});

test("a row override beats the manifest for that field only", () => {
  const run = buildBackfillRunProvenance("t");
  assert.equal(resolveFieldProvenance("price_usd", run, BACKFILL_PRICE_FALLBACK_OVERRIDE, ctx)?.source, "coingecko");
  assert.equal(resolveFieldProvenance("fees_24h", run, BACKFILL_PRICE_FALLBACK_OVERRIDE, ctx)?.source.startsWith("defillama"), true);
});

test("a field the run never wrote has no provenance (null), not a guessed one", () => {
  assert.equal(resolveFieldProvenance("fdv_usd", buildBackfillRunProvenance("t"), null, ctx), null);
});

test("a degraded run's manifest names DefiLlama for price and records the CoinGecko fields as not fetched", () => {
  const m = buildLiveRunProvenance("2026-09-23T07:00:00Z", { degraded: true });
  assert.equal(m.fields.price_usd.source, "defillama");
  for (const f of ["market_cap_usd", "fdv_usd", "circulating_supply", "total_supply", "max_supply", "volume_24h_usd"]) {
    assert.match(m.fields[f].source, /not fetched/, f);
  }
  assert.equal(m.fields.fees_30d.source, "defillama", "DefiLlama fields are unaffected");
  assert.deepEqual(Object.keys(m.fields).sort(), Object.keys(buildLiveRunProvenance("t").fields).sort(), "same field set as a complete run");
});
