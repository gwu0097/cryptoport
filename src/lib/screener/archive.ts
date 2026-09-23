// Pure pieces of the monthly snapshot archive (scripts/screener-archive.ts
// does the DB/file I/O) — see archive.test.ts.
//
// Retention plan (agreed 2026-09-22): every month, snapshot rows older than
// 400 days are exported to local Parquet, the file is read back and
// verified row-for-row against what was fetched, and only then are those
// rows deleted from Supabase. Runs monthly from the start (not on a quota
// trigger) so the archive path is exercised long before it matters —
// backfilled rows (re-derivable) start crossing 400 days ~35 days after a
// 365-day backfill, well before any irreplaceable live row does.

import { createHash } from "node:crypto";

export const ARCHIVE_AFTER_DAYS = 400;

type ColumnType = "STRING" | "DOUBLE" | "BOOLEAN" | "JSON";

/** Every column written to the archive, in file order. observed_at stays a
 * string exactly as PostgREST returned it (lossless; timestamptz has µs
 * precision a JS Date would truncate) — cast on read (`observed_at::timestamptz`
 * in DuckDB). The legacy per-row `provenance` column is deliberately
 * absent: step B drops it, and each row's provenance is its run's manifest
 * (archived alongside, in the runs file) plus `provenance_override`. */
export const SNAPSHOT_ARCHIVE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: "id", type: "STRING" },
  { name: "asset_id", type: "STRING" },
  { name: "observed_at", type: "STRING" },
  { name: "run_id", type: "STRING" },
  { name: "is_backfilled", type: "BOOLEAN" },
  { name: "price_usd", type: "DOUBLE" },
  { name: "market_cap_usd", type: "DOUBLE" },
  { name: "fdv_usd", type: "DOUBLE" },
  { name: "circulating_supply", type: "DOUBLE" },
  { name: "total_supply", type: "DOUBLE" },
  { name: "max_supply", type: "DOUBLE" },
  { name: "tvl_usd", type: "DOUBLE" },
  { name: "fees_24h", type: "DOUBLE" },
  { name: "fees_7d", type: "DOUBLE" },
  { name: "fees_30d", type: "DOUBLE" },
  { name: "fees_1y", type: "DOUBLE" },
  { name: "revenue_24h", type: "DOUBLE" },
  { name: "revenue_7d", type: "DOUBLE" },
  { name: "revenue_30d", type: "DOUBLE" },
  { name: "revenue_1y", type: "DOUBLE" },
  { name: "holders_revenue_24h", type: "DOUBLE" },
  { name: "holders_revenue_30d", type: "DOUBLE" },
  { name: "volume_24h_usd", type: "DOUBLE" },
  { name: "contributing_slugs", type: "JSON" },
  { name: "provenance_override", type: "JSON" },
];

export const RUN_ARCHIVE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: "id", type: "STRING" },
  { name: "started_at", type: "STRING" },
  { name: "finished_at", type: "STRING" },
  { name: "kind", type: "STRING" },
  { name: "status", type: "STRING" },
  { name: "degraded", type: "BOOLEAN" },
  { name: "provenance", type: "JSON" },
  { name: "notes", type: "JSON" },
];

/** screener_asset_metrics — derived (recomputable from snapshots + the
 * versioned config), kept 90 days in Supabase, then archived and deleted
 * like snapshots. Decided 2026-09-22. */
export const METRICS_ARCHIVE_AFTER_DAYS = 90;

export const METRICS_ARCHIVE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: "run_id", type: "STRING" },
  { name: "asset_id", type: "STRING" },
  { name: "config_version_id", type: "STRING" },
  { name: "computed_at", type: "STRING" },
  { name: "sector_bucket", type: "STRING" },
  ...[
    "fees_ann", "rev_ann", "holders_rev_ann", "pf_fd", "pf_circ", "ps_fd", "ps_circ", "capture", "buyback_yield",
    "float_ratio", "mc_tvl", "size_log_mcap", "mom_3w", "mom_12w", "beta_btc", "dilution_rate", "dilution_rate_implied",
    "rev_growth", "rev_90d_change",
  ].map((name) => ({ name, type: "DOUBLE" as const })),
  { name: "rated", type: "BOOLEAN" },
  { name: "gate_status", type: "JSON" },
];

/** screener_asset_scores (Phase 3) — derived like metrics (recomputable
 * from metrics + the versioned config), same 90-day retention. */
export const SCORES_ARCHIVE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: "run_id", type: "STRING" },
  { name: "asset_id", type: "STRING" },
  { name: "config_version_id", type: "STRING" },
  { name: "computed_at", type: "STRING" },
  { name: "quality_risk_tier", type: "STRING" },
  { name: "quality_risk_rules", type: "JSON" },
  { name: "rules_evaluable", type: "DOUBLE" },
  { name: "timing_score", type: "DOUBLE" },
  { name: "timing_percentile", type: "DOUBLE" },
  { name: "timing_grade_raw", type: "STRING" },
  { name: "timing_grade", type: "STRING" },
  { name: "momentum_tercile", type: "DOUBLE" },
  { name: "setup_tag", type: "STRING" },
  { name: "confidence", type: "STRING" },
  { name: "size_bucket", type: "STRING" },
  { name: "score_breakdown", type: "JSON" },
];

export const SNAPSHOT_SELECT = SNAPSHOT_ARCHIVE_COLUMNS.map((c) => c.name).join(", ");
export const METRICS_SELECT = METRICS_ARCHIVE_COLUMNS.map((c) => c.name).join(", ");
export const SCORES_SELECT = SCORES_ARCHIVE_COLUMNS.map((c) => c.name).join(", ");
export const RUN_SELECT = RUN_ARCHIVE_COLUMNS.map((c) => c.name).join(", ");

type Row = Record<string, unknown>;

/** Column-major data for hyparquet-writer. JSON columns are passed as the
 * raw objects PostgREST returned — the writer serializes the `JSON` type
 * itself; pre-stringifying here double-encodes (caught by reading a test
 * archive back with DuckDB: `notes` came out as a JSON *string* of JSON). */
export function toColumnData(rows: readonly Row[], columns: readonly { name: string; type: ColumnType }[]) {
  return columns.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: true,
    data: rows.map((r) => r[c.name] ?? null),
  }));
}

function canonicalValue(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined) return "∅";
  // No string->object coercion for JSON: a value that reads back as a
  // string where an object went in must NOT fingerprint equal.
  if (type === "JSON") return JSON.stringify(v);
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/** Order-independent content fingerprint: row count + SHA-256 over every
 * column of every row, rows sorted by id. The archive is only trusted (and
 * the DB rows only deleted) if the fingerprint of what was fetched from
 * Postgres equals the fingerprint of what reads back from the file. */
export function fingerprint(rows: readonly Row[], columns: readonly { name: string; type: ColumnType }[]): { rows: number; sha256: string } {
  const lines = rows.map((r) => columns.map((c) => canonicalValue(r[c.name], c.type)).join("\u001f"));
  lines.sort();
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line).update("\n");
  return { rows: rows.length, sha256: hash.digest("hex") };
}

/** [from, to) window for a run. Default: everything observed before
 * now − ARCHIVE_AFTER_DAYS. An explicit range is for testing on a small
 * slice. */
export function archiveWindow(
  now: Date,
  explicit?: { from?: string; to?: string },
  afterDays: number = ARCHIVE_AFTER_DAYS,
): { from: string | null; to: string } {
  if (explicit?.to) return { from: explicit.from ?? null, to: new Date(explicit.to).toISOString() };
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - afterDays);
  return { from: explicit?.from ?? null, to: cutoff.toISOString() };
}

/** Writes rows to a Parquet file via a `.partial` temp file, reads it back,
 * and only renames it into place if the read-back content fingerprint
 * matches what was written (throws otherwise). Returns the content SHA-256.
 * Shared by the monthly archive and Phase 4's deep-history store. Node-only
 * (fs + hyparquet); used by scripts, never by the app. */
export async function writeParquetVerified(
  path: string,
  rows: readonly Row[],
  columns: readonly { name: string; type: ColumnType }[],
): Promise<string> {
  const { parquetWriteFile } = await import("hyparquet-writer");
  const { parquetReadObjects, asyncBufferFromFile } = await import("hyparquet/src/node.js");
  const { renameSync } = await import("node:fs");
  const tmp = `${path}.partial`;
  parquetWriteFile({ filename: tmp, columnData: toColumnData(rows, columns) as never });
  const readBack = (await parquetReadObjects({ file: await asyncBufferFromFile(tmp) })) as Row[];
  const want = fingerprint(rows, columns);
  const got = fingerprint(readBack, columns);
  if (want.rows !== got.rows || want.sha256 !== got.sha256) {
    throw new Error(`verification FAILED for ${path}: wrote ${want.rows} rows/${want.sha256}, file has ${got.rows} rows/${got.sha256}`);
  }
  renameSync(tmp, path);
  return want.sha256;
}
