import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parquetWriteFile } from "hyparquet-writer";
import { parquetReadObjects, asyncBufferFromFile } from "hyparquet/src/node.js";
import { SNAPSHOT_ARCHIVE_COLUMNS, RUN_ARCHIVE_COLUMNS, SCORES_ARCHIVE_COLUMNS, toColumnData, fingerprint, archiveWindow } from "./archive.ts";

function snapshotRow(id: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {};
  for (const c of SNAPSHOT_ARCHIVE_COLUMNS) row[c.name] = null;
  return {
    ...row,
    id,
    asset_id: "asset-1",
    observed_at: "2025-08-01T12:00:00+00:00",
    run_id: "run-1",
    is_backfilled: true,
    price_usd: 1.2345678901234567,
    fees_30d: 1e12,
    contributing_slugs: ["uniswap-v2", "uniswap-v3"],
    provenance_override: { price_usd: { source: "coingecko", endpoint: "/coins/{gecko_id}/market_chart" } },
    ...overrides,
  };
}

test("parquet round trip is lossless: doubles, nulls, booleans, JSON arrays/objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screener-archive-test-"));
  try {
    const rows = [snapshotRow("b"), snapshotRow("a", { contributing_slugs: null, provenance_override: null, is_backfilled: false })];
    const file = join(dir, "t.parquet");
    parquetWriteFile({ filename: file, columnData: toColumnData(rows, SNAPSHOT_ARCHIVE_COLUMNS) as never });
    const back = (await parquetReadObjects({ file: await asyncBufferFromFile(file) })) as Record<string, unknown>[];
    assert.deepEqual(fingerprint(back, SNAPSHOT_ARCHIVE_COLUMNS), fingerprint(rows, SNAPSHOT_ARCHIVE_COLUMNS));
    const b = back.find((r) => r.id === "b")!;
    assert.deepEqual(b.contributing_slugs, ["uniswap-v2", "uniswap-v3"], "JSON must come back as the array, not a string of it");
    assert.equal(b.price_usd, 1.2345678901234567);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs file round trip keeps notes/provenance as objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screener-archive-test-"));
  try {
    const runs = [{ id: "r", started_at: "s", finished_at: null, kind: "live", status: "ok", provenance: { fetched_at: "t", fields: {} }, notes: { gap_dates: ["2026-09-21"] } }];
    const file = join(dir, "r.parquet");
    parquetWriteFile({ filename: file, columnData: toColumnData(runs, RUN_ARCHIVE_COLUMNS) as never });
    const back = (await parquetReadObjects({ file: await asyncBufferFromFile(file) })) as Record<string, unknown>[];
    assert.deepEqual(back[0].notes, { gap_dates: ["2026-09-21"] });
    assert.deepEqual(fingerprint(back, RUN_ARCHIVE_COLUMNS), fingerprint(runs, RUN_ARCHIVE_COLUMNS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scores file round trip keeps rules/breakdown as objects and null grades as null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screener-archive-test-"));
  try {
    const base = {
      run_id: "r", config_version_id: "c", computed_at: "2026-09-23T08:00:00+00:00", quality_risk_tier: "pass",
      quality_risk_rules: [{ rule: "revenue_90d_drop", tier: "high_risk", fired: null, input: null, threshold: -0.4 }],
      rules_evaluable: 1, confidence: "high", size_bucket: "mid",
      score_breakdown: { legs: { mom_3w: { value: 0.1, percentile: 0.5 } }, legs_used: 1 },
    };
    const rows = [
      { ...base, asset_id: "a", timing_score: 0.93, timing_percentile: 0.97, timing_grade_raw: "A", timing_grade: "C", momentum_tercile: 1, setup_tag: "SPECULATIVE" },
      { ...base, asset_id: "b", timing_score: null, timing_percentile: null, timing_grade_raw: null, timing_grade: null, momentum_tercile: null, setup_tag: null },
    ];
    const file = join(dir, "s.parquet");
    parquetWriteFile({ filename: file, columnData: toColumnData(rows, SCORES_ARCHIVE_COLUMNS) as never });
    const back = (await parquetReadObjects({ file: await asyncBufferFromFile(file) })) as Record<string, unknown>[];
    assert.deepEqual(fingerprint(back, SCORES_ARCHIVE_COLUMNS), fingerprint(rows, SCORES_ARCHIVE_COLUMNS));
    assert.deepEqual(back.find((r) => r.asset_id === "a")!.quality_risk_rules, base.quality_risk_rules);
    assert.equal(back.find((r) => r.asset_id === "b")!.timing_grade, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprint is order-independent but catches any changed, missing, or re-typed value", () => {
  const rows = [snapshotRow("a"), snapshotRow("b")];
  const base = fingerprint(rows, SNAPSHOT_ARCHIVE_COLUMNS);
  assert.deepEqual(fingerprint([...rows].reverse(), SNAPSHOT_ARCHIVE_COLUMNS), base);
  assert.notDeepEqual(fingerprint([rows[0]], SNAPSHOT_ARCHIVE_COLUMNS), base);
  assert.notDeepEqual(fingerprint([rows[0], snapshotRow("b", { fees_30d: 1e12 + 1 })], SNAPSHOT_ARCHIVE_COLUMNS), base);
  assert.notDeepEqual(fingerprint([rows[0], snapshotRow("b", { fees_30d: null })], SNAPSHOT_ARCHIVE_COLUMNS), base);
  const doubleEncoded = snapshotRow("b", { contributing_slugs: JSON.stringify(["uniswap-v2", "uniswap-v3"]) });
  assert.notDeepEqual(fingerprint([rows[0], doubleEncoded], SNAPSHOT_ARCHIVE_COLUMNS), base, "a JSON string must not equal the object it encodes");
});

test("archiveWindow defaults to everything older than 400 days; explicit range wins", () => {
  const w = archiveWindow(new Date("2027-11-01T00:00:00Z"));
  assert.deepEqual(w, { from: null, to: "2026-09-27T00:00:00.000Z" });
  assert.deepEqual(archiveWindow(new Date(), { from: "2026-09-22T16:40:00Z", to: "2026-09-22T16:50:00Z" }), {
    from: "2026-09-22T16:40:00Z",
    to: "2026-09-22T16:50:00.000Z",
  });
});
